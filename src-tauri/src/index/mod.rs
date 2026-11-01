//! The `index` area: each world's pages, their aliases and their wiki links, with the page each
//! link resolves to, kept in a cache database in the app data folder. It knows nothing about Tauri
//! or confinement, and it never reads or writes a world folder: the world area gives it paths,
//! parsed text and file stamps, and a closure for a page's stamp on disk now.
//!
//! An entry is only ever stored from bytes that are still on disk when it is stored: `apply` takes
//! the stamp a page had when it was read and refuses the page, for reading again, when its stamp
//! changed since. When the set of pages or any alias changes, every stored link needs resolving
//! again; the index asks for that full pass, and its owner runs it in steps.

mod database;
mod parse;
mod resolve;
mod search;
mod suggest;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params, types::Value};
use serde::Serialize;

use crate::order::{natural_order, path_order};
pub use database::file;
pub use parse::{Parsed, parse};
use resolve::Table;
pub use resolve::creation_path;
pub use search::PageMatches;
pub use suggest::LinkSuggestions;

/// How many pages one `apply` should take, and how many links one step of a full pass resolves,
/// which bounds how long the index's lock is held at a time.
pub const BATCH_PAGES: usize = 100;
const RESOLVE_CHUNK: usize = 5_000;

/// A page file's size and modification time, which tell whether it changed since it was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    /// Nanoseconds since the Unix epoch.
    pub modified: i64,
}

/// What a page holds for the index: its parse, or nothing when it is not UTF-8 text.
#[derive(Debug)]
pub enum Content {
    Parsed(Parsed),
    Unreadable,
}

/// A page read from disk, to store.
#[derive(Debug)]
pub struct Page {
    pub path: String,
    /// Its stamp when it was read.
    pub stamp: Stamp,
    pub content: Content,
}

/// What `apply` did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// A stored page, alias or link changed.
    pub changed: bool,
    /// Pages whose stamp changed since they were read, which were not stored and need reading again.
    pub stale: Vec<String>,
}

/// Where a full pass continues: the last link it resolved, by (source, ordinal).
pub type Cursor = (String, i64);

/// One step of a full pass.
#[derive(Debug)]
pub struct Step {
    /// Where the next step continues; `None` once every link is resolved.
    pub next: Option<Cursor>,
    /// A link's resolved page changed.
    pub changed: bool,
}

/// How far the index of this opening is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildState {
    /// It is being built from the files, and may hold only some of them.
    Building,
    Ready,
    /// The world could not be listed, for the reason given.
    Failed(String),
}

/// A page that links to another, as the backlinks section lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Backlink {
    /// The linking page's path, relative to the world.
    pub path: String,
    /// Its name, without `.md`.
    pub name: String,
    /// The line that holds its first link to the page, cut around the link.
    pub line: String,
    /// Where that link starts in the linking page's text, in UTF-16 code units.
    pub at: u64,
}

/// The pages that link to a page, once the index is built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Backlinks {
    Building,
    Failed { message: String },
    Ready { pages: Vec<Backlink> },
}

/// What a link in the editor leads to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    Resolved,
    Unresolved,
    /// It names an image, audio, video or PDF file, which the index leaves out.
    Attachment,
}

/// A link in the editor's text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct EditorLink {
    /// Where the whole link starts and ends in the text, in UTF-16 code units.
    pub from: u64,
    pub to: u64,
    pub state: LinkState,
    /// The link's page part, without surrounding whitespace and `.md`; empty for a link to the
    /// page it is in.
    pub target: String,
    /// The path of the page it resolves to.
    pub path: Option<String>,
    pub heading: Option<String>,
    pub block: Option<String>,
}

/// The links of the editor's text, once the index is built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EditorLinks {
    NotReady,
    Ready { links: Vec<EditorLink> },
}

/// The index of one opening of a world.
pub struct Index {
    connection: Connection,
    /// The cache file the connection uses; `None` once the index is in memory.
    file: Option<PathBuf>,
    world: String,
    state: BuildState,
    /// The pages and aliases for resolving, while they are unchanged.
    table: Option<Table>,
    /// Every stored link needs resolving again.
    full_pass: bool,
    /// The stored rows were lost, so every page needs reading again.
    rebuild: bool,
}

impl Index {
    /// The index of the world at `world`, kept in the cache `file`, or in memory without one or when
    /// the file cannot be used. It starts `Building`.
    pub fn open(file: Option<&Path>, world: &str) -> Self {
        let stored = file.and_then(|file| Some((database::open(file, world)?, file.to_path_buf())));
        let (connection, file) = match stored {
            Some((connection, file)) => (connection, Some(file)),
            None => (database::open_in_memory(world), None),
        };
        Self {
            connection,
            file,
            world: world.to_owned(),
            state: BuildState::Building,
            table: None,
            full_pass: false,
            rebuild: false,
        }
    }

    /// Whether the index is kept in its cache file rather than in memory.
    #[cfg(test)]
    pub fn is_stored(&self) -> bool {
        self.file.is_some()
    }

    pub fn state(&self) -> &BuildState {
        &self.state
    }

    pub fn set_state(&mut self, state: BuildState) {
        self.state = state;
    }

    /// Whether the index lost its rows and every page needs reading again; asking clears it.
    pub fn take_rebuild(&mut self) -> bool {
        std::mem::take(&mut self.rebuild)
    }

    /// Asks for a full pass, as every opening's build does before the index is ready, so a pass
    /// that an earlier opening left unfinished cannot leave a link's page stale.
    pub fn ask_full_pass(&mut self) {
        self.full_pass = true;
    }

    /// Whether every stored link needs resolving again; asking clears it.
    pub fn take_full_pass(&mut self) -> bool {
        std::mem::take(&mut self.full_pass)
    }

    /// Whether the owner's worker has work: a rebuild or a full pass.
    pub fn needs_worker(&self) -> bool {
        self.rebuild || self.full_pass
    }

    /// The stamp of every stored page, by path.
    pub fn stamps(&mut self) -> rusqlite::Result<HashMap<String, Stamp>> {
        self.stored(|index| {
            let mut statement = index
                .connection
                .prepare("SELECT path, size, modified FROM pages")?;
            let rows = statement.query_map([], |row| {
                let stamp = Stamp {
                    size: row.get::<_, i64>(1)? as u64,
                    modified: row.get(2)?,
                };
                Ok((row.get::<_, String>(0)?, stamp))
            })?;
            rows.collect()
        })
    }

    /// Stores `pages`, each unless `stamp_now` says its stamp on disk is no longer the one it was
    /// read at. A stored page's own links are resolved at once unless the index is being built. A
    /// new page, a change to a page's aliases, or links stored while it is being built ask for a
    /// full pass.
    pub fn apply(
        &mut self,
        pages: &[Page],
        mut stamp_now: impl FnMut(&str) -> Option<Stamp>,
    ) -> rusqlite::Result<Applied> {
        self.stored(|index| index.apply_now(pages, &mut stamp_now))
    }

    /// Removes the pages at `paths`, with their aliases and links. Removing a stored page asks for
    /// a full pass. Returns whether any was stored.
    pub fn remove(&mut self, paths: &[String]) -> rusqlite::Result<bool> {
        self.stored(|index| {
            let transaction = index.connection.transaction()?;
            let mut removed = false;
            for path in paths {
                removed |= transaction.execute("DELETE FROM pages WHERE path = ?1", [path])? > 0;
                transaction.execute("DELETE FROM aliases WHERE path = ?1", [path])?;
                transaction.execute("DELETE FROM links WHERE source = ?1", [path])?;
            }
            transaction.commit()?;
            if removed {
                index.table = None;
                index.full_pass = true;
            }
            Ok(removed)
        })
    }

    /// Resolves the next stored links of a full pass, after `after`, and writes the ones whose
    /// page changed.
    pub fn resolve_step(&mut self, after: Option<&Cursor>) -> rusqlite::Result<Step> {
        self.stored(|index| index.resolve_step_now(after))
    }

    /// The pages other than the page at `path` that link to it, each with its first such link.
    pub fn backlinks(&mut self, path: &str) -> rusqlite::Result<Backlinks> {
        if self.state != BuildState::Ready {
            return Ok(self.not_ready());
        }
        let pages = self.stored(|index| index.backlinks_now(path))?;
        // A storage failure during the query can have emptied the index.
        Ok(match self.state {
            BuildState::Ready => Backlinks::Ready { pages },
            _ => self.not_ready(),
        })
    }

    /// The links of `parsed`, the parse of the editor's text of the page at `from`, each with the
    /// page it resolves to.
    pub fn links_in(&mut self, from: &str, parsed: &Parsed) -> rusqlite::Result<EditorLinks> {
        if self.state != BuildState::Ready {
            return Ok(EditorLinks::NotReady);
        }
        let links = self.stored(|index| {
            let table = index.table()?;
            Ok(parsed
                .links
                .iter()
                .map(|link| editor_link(table, from, link))
                .collect())
        })?;
        // A storage failure during the query can have emptied the index.
        Ok(match self.state {
            BuildState::Ready => EditorLinks::Ready { links },
            _ => EditorLinks::NotReady,
        })
    }

    /// The page that a link in the page at `from` to `target` resolves to now, while the index is
    /// built; `None` when it is not built or nothing matches.
    pub fn resolve(&mut self, from: &str, target: &str) -> rusqlite::Result<Option<String>> {
        if self.state != BuildState::Ready {
            return Ok(None);
        }
        self.stored(|index| Ok(index.table()?.resolve(from, target).map(str::to_owned)))
    }

    /// The pages to suggest for a link in the page at `from` whose page part so far is `query`,
    /// from the pages stored now: while the index is being built, those it has read so far.
    pub fn suggest(&mut self, from: &str, query: &str) -> rusqlite::Result<LinkSuggestions> {
        let (pages, aliases) = self.stored(|index| stored_pages(&index.connection))?;
        Ok(LinkSuggestions {
            // Checked after reading, because a storage failure can have emptied the index.
            indexing: self.state == BuildState::Building,
            items: suggest::suggest(&pages, &aliases, from, query),
        })
    }

    /// The pages whose name, alias or path matches `query`, from the pages stored now: while the
    /// index is being built, those it has read so far.
    pub fn search_pages(&mut self, query: &str) -> rusqlite::Result<PageMatches> {
        let (pages, aliases) = self.stored(|index| stored_pages(&index.connection))?;
        let pages = search::page_matches(&pages, &aliases, query);
        // Checked after reading, because a storage failure can have emptied the index.
        Ok(match &self.state {
            BuildState::Building => PageMatches::Building { pages },
            BuildState::Ready => PageMatches::Ready { pages },
            BuildState::Failed(message) => PageMatches::Failed {
                message: message.clone(),
            },
        })
    }

    /// The pages and aliases for resolving, loaded when they changed since they were last used.
    fn table(&mut self) -> rusqlite::Result<&Table> {
        if self.table.is_none() {
            self.table = Some(load_table(&self.connection)?);
        }
        Ok(self.table.as_ref().expect("the table was loaded above"))
    }

    fn not_ready(&self) -> Backlinks {
        match &self.state {
            BuildState::Failed(message) => Backlinks::Failed {
                message: message.clone(),
            },
            _ => Backlinks::Building,
        }
    }

    /// Runs `operation`, and when it fails while the index is kept in its file, moves the index to
    /// memory and runs it again there.
    fn stored<T>(
        &mut self,
        mut operation: impl FnMut(&mut Self) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        match operation(self) {
            Err(_) if self.file.is_some() => {
                self.move_to_memory();
                operation(self)
            }
            result => result,
        }
    }

    /// Moves the index from its file, which failed, to memory, copying the stored rows when the
    /// file can still be read. When it cannot, the index starts empty, goes back to `Building` and
    /// asks for a rebuild.
    fn move_to_memory(&mut self) {
        let Some(file) = self.file.take() else {
            return;
        };
        let mut memory = database::open_in_memory(&self.world);
        let copied = copy_stored(&file, &self.world, &mut memory).is_ok();
        self.connection = memory;
        self.table = None;
        if !copied {
            self.state = BuildState::Building;
            self.rebuild = true;
            self.full_pass = false;
        }
    }

    fn apply_now(
        &mut self,
        pages: &[Page],
        stamp_now: &mut impl FnMut(&str) -> Option<Stamp>,
    ) -> rusqlite::Result<Applied> {
        let resolve_now = self.state != BuildState::Building;
        let transaction = self.connection.transaction()?;
        let mut applied = Applied::default();
        let mut structural = false;
        let mut relinked = Vec::new();
        for page in pages {
            if stamp_now(&page.path) != Some(page.stamp) {
                applied.stale.push(page.path.clone());
                continue;
            }
            let (aliases, links) = match &page.content {
                Content::Parsed(parsed) => (parsed.aliases.as_slice(), parsed.links.as_slice()),
                Content::Unreadable => (&[][..], &[][..]),
            };
            let links: Vec<&parse::Link> = links.iter().filter(|link| !link.attachment).collect();
            let existed = store_page(&transaction, page)?;
            let aliases_changed = store_aliases(&transaction, &page.path, aliases)?;
            let links_changed = stored_links(&transaction, &page.path)? != links_as_stored(&links);
            structural |= !existed || aliases_changed;
            applied.changed |= !existed || aliases_changed || links_changed;
            if links_changed {
                relinked.push((page.path.as_str(), links));
            }
        }
        // Links are written once the batch's pages and aliases are in, so they can resolve to them.
        let mut table = if structural { None } else { self.table.take() };
        if resolve_now && !relinked.is_empty() && table.is_none() {
            table = Some(load_table(&transaction)?);
        }
        for (path, links) in &relinked {
            let table = table.as_ref().filter(|_| resolve_now);
            store_links(&transaction, path, links, table)?;
        }
        transaction.commit()?;
        self.table = table;
        // Links stored unresolved during the build may lie behind its pass's cursor.
        self.full_pass |= structural || (!resolve_now && !relinked.is_empty());
        Ok(applied)
    }

    fn resolve_step_now(&mut self, after: Option<&Cursor>) -> rusqlite::Result<Step> {
        if self.table.is_none() {
            self.table = Some(load_table(&self.connection)?);
        }
        let table = self.table.as_ref().expect("the table was loaded above");
        let rows: Vec<(String, i64, String, Option<String>)> = {
            let mut statement = self.connection.prepare(
                "SELECT source, ordinal, target, resolved FROM links
                 WHERE (source, ordinal) > (?1, ?2) ORDER BY source, ordinal LIMIT ?3",
            )?;
            let (source, ordinal) = after.map_or(("", -1), |(source, ordinal)| (source, *ordinal));
            statement
                .query_map(params![source, ordinal, RESOLVE_CHUNK as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<rusqlite::Result<_>>()?
        };
        let transaction = self.connection.transaction()?;
        let mut changed = false;
        for (source, ordinal, target, stored) in &rows {
            let resolved = table.resolve(source, target);
            if resolved != stored.as_deref() {
                transaction.execute(
                    "UPDATE links SET resolved = ?1 WHERE source = ?2 AND ordinal = ?3",
                    params![resolved, source, ordinal],
                )?;
                changed = true;
            }
        }
        transaction.commit()?;
        let next = (rows.len() == RESOLVE_CHUNK)
            .then(|| {
                rows.last()
                    .map(|(source, ordinal, ..)| (source.clone(), *ordinal))
            })
            .flatten();
        Ok(Step { next, changed })
    }

    fn backlinks_now(&mut self, path: &str) -> rusqlite::Result<Vec<Backlink>> {
        let mut statement = self.connection.prepare(
            "SELECT source, start, line FROM links WHERE resolved = ?1 AND source != ?1
             ORDER BY source, ordinal",
        )?;
        let mut pages: Vec<Backlink> = Vec::new();
        let rows = statement.query_map([path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get(2)?))
        })?;
        for row in rows {
            let (source, at, line) = row?;
            if pages.last().is_some_and(|last| last.path == source) {
                continue;
            }
            pages.push(Backlink {
                name: page_name(&source).to_owned(),
                path: source,
                line,
                at: at as u64,
            });
        }
        pages.sort_by(|a, b| {
            natural_order(&a.name, &b.name).then_with(|| path_order(&a.path, &b.path))
        });
        Ok(pages)
    }
}

fn editor_link(table: &Table, from: &str, link: &parse::Link) -> EditorLink {
    let path = (!link.attachment)
        .then(|| table.resolve(from, &link.target))
        .flatten();
    let state = match (link.attachment, &path) {
        (true, _) => LinkState::Attachment,
        (false, Some(_)) => LinkState::Resolved,
        (false, None) => LinkState::Unresolved,
    };
    EditorLink {
        from: link.start,
        to: link.end,
        state,
        target: link.target.clone(),
        path: path.map(str::to_owned),
        heading: link.heading.clone(),
        block: link.block.clone(),
    }
}

/// A page's name: its file name without `.md`.
pub fn page_name(path: &str) -> &str {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let cut = file_name.len().saturating_sub(3);
    match file_name.get(cut..) {
        Some(extension) if extension.eq_ignore_ascii_case(".md") => &file_name[..cut],
        _ => file_name,
    }
}

/// Stores a page's stamp, and returns whether it was stored before.
fn store_page(transaction: &Transaction, page: &Page) -> rusqlite::Result<bool> {
    let existed = transaction
        .query_row("SELECT 1 FROM pages WHERE path = ?1", [&page.path], |_| {
            Ok(())
        })
        .optional()?
        .is_some();
    transaction.execute(
        "INSERT OR REPLACE INTO pages (path, size, modified, readable) VALUES (?1, ?2, ?3, ?4)",
        params![
            page.path,
            page.stamp.size as i64,
            page.stamp.modified,
            matches!(page.content, Content::Parsed(_)),
        ],
    )?;
    Ok(existed)
}

/// Replaces a page's aliases when they differ from the stored ones, and returns whether they did.
fn store_aliases(
    transaction: &Transaction,
    path: &str,
    aliases: &[String],
) -> rusqlite::Result<bool> {
    let mut stored: Vec<String> = transaction
        .prepare("SELECT alias FROM aliases WHERE path = ?1")?
        .query_map([path], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut wanted = aliases.to_vec();
    stored.sort();
    wanted.sort();
    if stored == wanted {
        return Ok(false);
    }
    transaction.execute("DELETE FROM aliases WHERE path = ?1", [path])?;
    for alias in &wanted {
        transaction.execute(
            "INSERT INTO aliases (path, alias, key) VALUES (?1, ?2, ?3)",
            params![path, alias, alias.to_lowercase()],
        )?;
    }
    Ok(true)
}

/// A link's stored columns, without its resolved page.
type StoredLink = (
    i64,
    i64,
    String,
    Option<String>,
    Option<String>,
    bool,
    String,
);

fn stored_links(transaction: &Transaction, source: &str) -> rusqlite::Result<Vec<StoredLink>> {
    transaction
        .prepare(
            "SELECT start, finish, target, heading, block, embed, line FROM links
             WHERE source = ?1 ORDER BY ordinal",
        )?
        .query_map([source], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })?
        .collect()
}

fn links_as_stored(links: &[&parse::Link]) -> Vec<StoredLink> {
    links
        .iter()
        .map(|link| {
            (
                link.start as i64,
                link.end as i64,
                link.target.clone(),
                link.heading.clone(),
                link.block.clone(),
                link.embed,
                link.line.clone(),
            )
        })
        .collect()
}

/// Replaces a page's links, resolved with `table`, or left unresolved without one.
fn store_links(
    transaction: &Transaction,
    source: &str,
    links: &[&parse::Link],
    table: Option<&Table>,
) -> rusqlite::Result<()> {
    transaction.execute("DELETE FROM links WHERE source = ?1", [source])?;
    let mut insert = transaction.prepare(
        "INSERT INTO links
         (source, ordinal, start, finish, target, key, heading, block, embed, line, resolved)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?;
    for (ordinal, link) in links.iter().enumerate() {
        let resolved = table.and_then(|table| table.resolve(source, &link.target));
        insert.execute(params![
            source,
            ordinal as i64,
            link.start as i64,
            link.end as i64,
            link.target,
            link.target.to_lowercase(),
            link.heading,
            link.block,
            link.embed,
            link.line,
            resolved,
        ])?;
    }
    Ok(())
}

/// Every stored page's path, and every stored alias as (page path, alias).
type Pages = (Vec<String>, Vec<(String, String)>);

fn stored_pages(connection: &Connection) -> rusqlite::Result<Pages> {
    let pages = connection
        .prepare("SELECT path FROM pages")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let aliases = connection
        .prepare("SELECT path, alias FROM aliases")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok((pages, aliases))
}

fn load_table(connection: &Connection) -> rusqlite::Result<Table> {
    let (pages, aliases) = stored_pages(connection)?;
    Ok(Table::new(
        pages.iter().map(String::as_str),
        aliases
            .iter()
            .map(|(path, alias)| (path.as_str(), alias.as_str())),
    ))
}

/// Copies the rows of the cache `file` of the world at `world` into `memory`, when the file can
/// still be read and holds format 1 for that world.
fn copy_stored(file: &Path, world: &str, memory: &mut Connection) -> rusqlite::Result<()> {
    let stored = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let format: i64 = stored.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let stored_world: String = stored.query_row("SELECT world FROM meta", [], |row| row.get(0))?;
    if format != database::FORMAT || stored_world != world {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let transaction = memory.transaction()?;
    for (table, columns) in [("pages", 4), ("aliases", 3), ("links", 11)] {
        let placeholders = vec!["?"; columns].join(", ");
        let mut insert =
            transaction.prepare(&format!("INSERT INTO {table} VALUES ({placeholders})"))?;
        let mut select = stored.prepare(&format!("SELECT * FROM {table}"))?;
        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            let values = (0..columns)
                .map(|column| row.get::<_, Value>(column))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            insert.execute(rusqlite::params_from_iter(values))?;
        }
    }
    drop(stored);
    transaction.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORLD: &str = "/home/tester/Worlds/Kesh";

    fn stamp(size: u64) -> Stamp {
        Stamp { size, modified: 1 }
    }

    fn page(path: &str, text: &str) -> Page {
        Page {
            path: path.to_owned(),
            stamp: stamp(text.len() as u64),
            content: Content::Parsed(parse(text, page_name(path))),
        }
    }

    /// Stores `pages` as read just now, so every stamp still matches.
    fn apply(index: &mut Index, pages: &[Page]) -> Applied {
        let stamps: HashMap<&str, Stamp> = pages
            .iter()
            .map(|page| (page.path.as_str(), page.stamp))
            .collect();
        index
            .apply(pages, |path| stamps.get(path).copied())
            .unwrap()
    }

    fn full_passes(index: &mut Index) {
        while index.take_full_pass() {
            let mut cursor = None;
            loop {
                let step = index.resolve_step(cursor.as_ref()).unwrap();
                match step.next {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
        }
    }

    /// An index built from `pages` and ready, as an opening's build leaves it.
    fn ready(pages: &[Page]) -> Index {
        let mut index = Index::open(None, WORLD);
        apply(&mut index, pages);
        full_passes(&mut index);
        index.set_state(BuildState::Ready);
        index
    }

    fn linking(index: &mut Index, path: &str) -> Vec<String> {
        match index.backlinks(path).unwrap() {
            Backlinks::Ready { pages } => pages.into_iter().map(|page| page.path).collect(),
            other => panic!("not ready: {other:?}"),
        }
    }

    #[test]
    fn new_and_removed_pages_and_aliases_keep_links_resolved() {
        let mut index = ready(&[
            page("Kesh Tor.md", "[[Saltmere]] and [[Mira]]"),
            page("Mirela.md", "# Mirela"),
        ]);
        assert!(linking(&mut index, "Saltmere.md").is_empty());

        // A new page resolves the links that waited for it, once the full pass runs.
        assert!(apply(&mut index, &[page("Saltmere.md", "# Saltmere")]).changed);
        full_passes(&mut index);
        assert_eq!(linking(&mut index, "Saltmere.md"), ["Kesh Tor.md"]);

        // An alias resolves links to it; moving it moves them.
        apply(
            &mut index,
            &[page("Mirela.md", "---\naliases: [Mira]\n---\n")],
        );
        full_passes(&mut index);
        assert_eq!(linking(&mut index, "Mirela.md"), ["Kesh Tor.md"]);
        apply(
            &mut index,
            &[
                page("Mirela.md", "# Mirela"),
                page("Saltmere.md", "---\naliases: Mira\n---\n"),
            ],
        );
        full_passes(&mut index);
        assert!(linking(&mut index, "Mirela.md").is_empty());
        assert_eq!(linking(&mut index, "Saltmere.md"), ["Kesh Tor.md"]);

        // A removed page unresolves them.
        assert!(index.remove(&["Saltmere.md".to_owned()]).unwrap());
        full_passes(&mut index);
        assert!(linking(&mut index, "Saltmere.md").is_empty());
    }

    #[test]
    fn a_changed_page_s_own_links_resolve_at_once() {
        let mut index = ready(&[page("Kesh Tor.md", ""), page("Mirela.md", "")]);

        apply(&mut index, &[page("Kesh Tor.md", "See [[Mirela]].")]);

        assert!(!index.needs_worker());
        assert_eq!(linking(&mut index, "Mirela.md"), ["Kesh Tor.md"]);
    }

    #[test]
    fn a_page_whose_stamp_changed_since_it_was_read_is_refused_for_reading_again() {
        let mut index = ready(&[page("Kesh Tor.md", "[[Mirela]]"), page("Mirela.md", "")]);
        let older = page("Kesh Tor.md", "no links");

        let applied = index.apply(&[older], |_| Some(stamp(999))).unwrap();

        assert_eq!(
            applied,
            Applied {
                changed: false,
                stale: vec!["Kesh Tor.md".to_owned()]
            }
        );
        assert_eq!(linking(&mut index, "Mirela.md"), ["Kesh Tor.md"]);
    }

    #[test]
    fn backlinks_list_each_other_page_once_in_name_then_path_order_with_its_first_link() {
        let mut index = ready(&[
            page("Mirela.md", "[[Mirela]] links itself"),
            page("Zeta.md", "x [[Mirela]]\n[[Mirela#Early]]"),
            page("Places/Ana.md", "[[Mirela|her]]"),
            page("Ana.md", "First\n\nAt [[mirela.md]] here"),
            page("Kesh.md", "[[Saltmere]] only"),
        ]);

        let Backlinks::Ready { pages } = index.backlinks("Mirela.md").unwrap() else {
            panic!("not ready");
        };

        // Between the two Anas, the tree's order puts the one in a folder first.
        assert_eq!(
            pages,
            [
                Backlink {
                    path: "Places/Ana.md".to_owned(),
                    name: "Ana".to_owned(),
                    line: "[[Mirela|her]]".to_owned(),
                    at: 0,
                },
                Backlink {
                    path: "Ana.md".to_owned(),
                    name: "Ana".to_owned(),
                    line: "At [[mirela.md]] here".to_owned(),
                    at: 10,
                },
                Backlink {
                    path: "Zeta.md".to_owned(),
                    name: "Zeta".to_owned(),
                    line: "x [[Mirela]]".to_owned(),
                    at: 2,
                },
            ]
        );
        assert_eq!(linking(&mut index, "Unknown.md"), Vec::<String>::new());
    }

    #[test]
    fn backlinks_say_when_the_index_is_not_ready() {
        let mut index = Index::open(None, WORLD);
        assert_eq!(index.backlinks("Mirela.md").unwrap(), Backlinks::Building);

        index.set_state(BuildState::Failed("Permission denied.".to_owned()));
        assert_eq!(
            index.backlinks("Mirela.md").unwrap(),
            Backlinks::Failed {
                message: "Permission denied.".to_owned()
            }
        );
    }

    #[test]
    fn a_full_pass_corrects_every_stale_resolved_target() {
        let mut index = ready(&[
            page("Kesh Tor.md", "[[Mirela]] [[Saltmere]]"),
            page("Mirela.md", ""),
        ]);
        index
            .connection
            .execute("UPDATE links SET resolved = 'Gone.md'", [])
            .unwrap();
        index.set_state(BuildState::Building);

        index.ask_full_pass();
        full_passes(&mut index);
        index.set_state(BuildState::Ready);

        let resolved: Vec<Option<String>> = index
            .connection
            .prepare("SELECT resolved FROM links ORDER BY ordinal")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(resolved, [Some("Mirela.md".to_owned()), None]);
    }

    #[test]
    fn a_full_pass_asked_for_while_one_runs_runs_after_it() {
        let mut index = ready(&[page("Kesh Tor.md", "[[Saltmere]] [[Mira]]")]);
        apply(&mut index, &[page("Saltmere.md", "")]);
        assert!(index.take_full_pass());

        // The pass is under way when a new alias asks for another.
        let first = index.resolve_step(None).unwrap();
        apply(
            &mut index,
            &[page("Mirela.md", "---\naliases: [Mira]\n---\n")],
        );
        assert!(first.next.is_none());
        assert!(index.needs_worker());

        full_passes(&mut index);
        assert_eq!(linking(&mut index, "Saltmere.md"), ["Kesh Tor.md"]);
        assert_eq!(linking(&mut index, "Mirela.md"), ["Kesh Tor.md"]);
    }

    #[test]
    fn a_save_during_the_build_after_its_pass_passed_the_page_is_resolved_before_ready() {
        let mut index = Index::open(None, WORLD);
        apply(
            &mut index,
            &[page("Kesh Tor.md", ""), page("Mirela.md", "")],
        );
        index.ask_full_pass();
        full_passes(&mut index);

        apply(&mut index, &[page("Kesh Tor.md", "[[Mirela]]")]);
        assert!(index.needs_worker());
        full_passes(&mut index);
        index.set_state(BuildState::Ready);

        assert_eq!(linking(&mut index, "Mirela.md"), ["Kesh Tor.md"]);
    }

    fn stored_index(app_data: &Path) -> (Index, PathBuf) {
        let file = file(app_data, WORLD);
        let mut index = Index::open(Some(&file), WORLD);
        assert!(index.is_stored());
        apply(
            &mut index,
            &[page("Kesh Tor.md", "[[Mirela]]"), page("Mirela.md", "")],
        );
        full_passes(&mut index);
        index.set_state(BuildState::Ready);
        (index, file)
    }

    #[cfg(unix)]
    #[test]
    fn an_index_whose_folder_turns_read_only_moves_to_memory_with_its_rows() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let app_data = tempfile::tempdir().unwrap();
        let (mut index, file) = stored_index(app_data.path());
        let folder = file.parent().unwrap().to_path_buf();

        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        let applied = apply(&mut index, &[page("Zeta.md", "[[Mirela]]")]);
        full_passes(&mut index);
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(applied.changed);
        assert!(!index.is_stored());
        assert_eq!(linking(&mut index, "Mirela.md"), ["Kesh Tor.md", "Zeta.md"]);
    }

    #[test]
    fn an_index_whose_file_is_overwritten_starts_empty_in_memory_and_asks_for_a_rebuild() {
        let app_data = tempfile::tempdir().unwrap();
        let (mut index, file) = stored_index(app_data.path());

        std::fs::write(&file, vec![0x5a; 8192]).unwrap();
        apply(&mut index, &[page("Zeta.md", "[[Mirela]]")]);

        assert!(!index.is_stored());
        assert!(index.take_rebuild());
        assert_eq!(index.backlinks("Mirela.md").unwrap(), Backlinks::Building);
    }
}
