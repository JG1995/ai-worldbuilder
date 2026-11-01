// An in-memory sample world for the browser preview (`pnpm dev`). Development builds only:
// `ipc.ts` loads this module behind `import.meta.env.DEV`, and `tools/check-dist.mjs` fails the
// check if the marker below, which every version token carries, appears in a production bundle.
import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
  Backlink,
  Backlinks,
  Comparison,
  DiffLine,
  EditorLink,
  EditorLinks,
  HistoryVersion,
  LinkedPage,
  LinkSuggestions,
  PageMatch,
  PageMatches,
  PageText,
  PageVersion,
  RecentWorld,
  RestoredPage,
  TextLine,
  TextMatch,
  TextMatches,
  TreeEntry,
  VersionKind,
  WorldOpened,
} from "@/types/api";

const previewMarker = "0.0.0-preview.sample-data";

/** A page's text, or `notUtf8` for a page whose bytes the core would refuse to decode. */
type SamplePage = string | { notUtf8: true };

const samplePages: Record<string, SamplePage> = {
  "Campaign overview.md": `---
title: The Glass Steppe
system: homebrew
tags: [overview, players]
---

# The Glass Steppe

A plain of fused sand where the old war ended. Caravans cross it by night, when the glass is cool.

## Travel rules

Each night of travel costs one water ration per rider. Roll on the table below for weather:

\`\`\`text
1-2  still air, clear stars
3-4  singing wind (no rests)
5-6  glass storm (shelter or take 2d6)
\`\`\`

Use \`inline code\` for dice notation such as \`3d6\`.
`,
  "Characters/Brother Ketil.md": "# Brother Ketil\n\nKeeper of the shrine at [[Kesh Tor]].\n",
  "Characters/Captain Orlaith Venn.md":
    "---\naliases: [Venn, The caravan master]\n---\n# Captain Orlaith Venn\n\nLeads the last caravan that still crosses in summer, guided by [[Brother Ketil|the old monk]].\n",
  "Characters/The salt merchant.md":
    "# The salt merchant\n\nNobody knows her name. She buys salt in [[Saltmere]].\n",
  "Factions/Glasswrights' Guild.md": "# Glasswrights' Guild\n\nThey mine the steppe for lenses.\n",
  "Factions/Riders of the Dun Sky.md": "# Riders of the Dun Sky\n\nNomads who never camp twice.\n",
  "Locations/Kesh Tor.md": "# Kesh Tor\n\nA basalt spire, the only shade for a day's ride.\n",
  "Locations/Locked chronicle.md":
    "# Locked chronicle\n\nIn the preview, another program holds this page open, so saving it always fails.\n",
  "Locations/Old trade ledger.md": { notUtf8: true },
  "Locations/The mirror lake.md": "# The mirror lake\n\nIts surface shows the sky of last night.\n",
  "Session notes/Session 1.md":
    "# Session 1\n\nThe party joins [[Captain Orlaith Venn|Venn]]'s caravan.\n",
  "Session notes/Session 2.md":
    "# Session 2\n\nA glass storm strands the caravan at [[Kesh Tor#Shelter]].\n",
  "Session notes/Session 10.md": "# Session 10\n\nThe Guild's lens finally works.\n",
};

/** The page whose saves always fail, so the failed-save notice and dialog can be seen. */
const lockedPage = "Locations/Locked chronicle.md";

/** A change the preview recorded in a page's history: its text before (null: no page) and after. */
type PreviewChange = {
  id: number;
  path: string;
  kind: VersionKind;
  at: number;
  before: string | null;
  after: string;
};

/**
 * A preview world: its pages, the folders created in it, how often each page was saved, and the
 * changes recorded in its history, oldest first. Unlike the core, every save is a change of its own.
 */
type PreviewWorld = {
  name: string;
  pages: Record<string, SamplePage>;
  folders: Set<string>;
  saves: Record<string, number>;
  changes: PreviewChange[];
};

const emptyWorld = (name: string): PreviewWorld => ({
  name,
  pages: {},
  folders: new Set(),
  saves: {},
  changes: [],
});

const sampleWorld: PreviewWorld = { ...emptyWorld("The Glass Steppe"), pages: samplePages };

const versionOf = (world: PreviewWorld, path: string) =>
  `${previewMarker}:${path}:${(world.saves[path] ?? 0) + 1}`;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The tree of a world's pages and folders, folders first and then by name, as the core sorts it. */
function treeOf(world: PreviewWorld): TreeEntry[] {
  const root: TreeEntry[] = [];
  const add = (path: string, kind: TreeEntry["kind"]) => {
    const segments = path.split("/");
    let level = root;
    segments.forEach((segment, index) => {
      const entryPath = segments.slice(0, index + 1).join("/");
      if (index === segments.length - 1 && kind === "page") {
        level.push({ path: entryPath, name: segment.replace(/\.md$/i, ""), kind: "page" });
        return;
      }
      let folder = level.find((entry) => entry.path === entryPath);
      if (!folder) {
        folder = { path: entryPath, name: segment, kind: "folder", children: [] };
        level.push(folder);
      }
      level = folder.children ?? [];
    });
  };
  for (const folder of world.folders) add(folder, "folder");
  for (const page of Object.keys(world.pages)) add(page, "page");
  const sort = (entries: TreeEntry[]): TreeEntry[] =>
    entries
      .map((entry) => (entry.children ? { ...entry, children: sort(entry.children) } : entry))
      .sort(
        (a, b) =>
          Number(a.kind === "page") - Number(b.kind === "page") || byName.compare(a.name, b.name),
      );
  return sort(root);
}

/** The names of the entries directly in `folder`, or at the top level when it is null. */
function namesIn(world: PreviewWorld, folder: string | null) {
  const prefix = folder === null ? "" : `${folder}/`;
  return [...Object.keys(world.pages), ...world.folders]
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).split("/")[0]);
}

const forbiddenCharacters = /[/\\:*?"<>|\p{Cc}]/u;

/**
 * A short copy of the core's naming rules (`src-tauri/src/world/names.rs`), enough to show their
 * errors in the preview. The core is the authority.
 */
function checkName(name: string) {
  const rule =
    name === ""
      ? "Names cannot be empty."
      : name.startsWith(".")
        ? "Names cannot start with a dot."
        : name.startsWith(" ") || name.endsWith(" ")
          ? "Names cannot start or end with a space."
          : name.endsWith(".")
            ? "Names cannot end with a dot."
            : forbiddenCharacters.test(name)
              ? 'Names cannot contain / \\ : * ? " < > | or control characters, which some systems forbid.'
              : /[[\]#^]/.test(name)
                ? "Names cannot contain [ ] # or ^, which break wiki links."
                : /^(con|prn|aux|nul|com[1-9]|lpt[1-9]) *$/i.test(name.split(".")[0])
                  ? "Windows reserves CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9, even with an extension."
                  : null;
  if (rule) throw { kind: "invalid_name", message: rule };
}

function checkFree(names: string[], fileName: string) {
  if (names.some((name) => name.toLowerCase() === fileName.toLowerCase())) {
    throw {
      kind: "exists",
      message: "Something with this name already exists here. Letter case does not count.",
    };
  }
}

let world: PreviewWorld | null = null;
let session = 0;

/** A recent world of the preview and the preview world it opens, or none for a missing folder. */
type PreviewRecent = RecentWorld & { world: PreviewWorld | null };

const sampleWorldPath = "/home/preview/Worlds/The Glass Steppe";

/** The preview's recent worlds, most recently opened first. */
let recentWorlds: PreviewRecent[] = [
  {
    id: "1",
    name: sampleWorld.name,
    path: sampleWorldPath,
    missing: false,
    world: sampleWorld,
  },
  {
    id: "2",
    name: "Ashfall Reaches",
    path: "/home/preview/Worlds/Ashfall Reaches",
    missing: false,
    world: emptyWorld("Ashfall Reaches"),
  },
  {
    id: "3",
    name: "The Sunken Archive",
    path: "/media/preview/backup/Worlds/The Sunken Archive",
    missing: true,
    world: null,
  },
];
let nextRecentId = recentWorlds.length + 1;

/** Moves an opened world to the top of the recent list, adding it when it is new. */
function remember(opened: PreviewWorld, path: string) {
  const known = recentWorlds.find((recent) => recent.world === opened);
  const entry = known ?? {
    id: String(nextRecentId++),
    name: opened.name,
    path,
    missing: false,
    world: opened,
  };
  recentWorlds = [entry, ...recentWorlds.filter((recent) => recent !== entry)];
}

function requireWorld() {
  if (!world) throw { kind: "no_world", message: "No world is open." };
  return world;
}

function opened(next: PreviewWorld): WorldOpened {
  world = next;
  session += 1;
  return {
    name: next.name,
    session,
    workspace: { tabs: [], active: null, expanded: [], treeWidth: 264 },
  };
}

/** The text of the page at `args.path`, throwing like the core for a missing or non-UTF-8 page. */
function pageText(args: InvokeArgs | undefined) {
  const open = requireWorld();
  const path = String((args as { path?: unknown } | undefined)?.path);
  const page = open.pages[path];
  if (page === undefined) {
    throw { kind: "not_found", message: "The page or folder does not exist." };
  }
  if (typeof page !== "string") {
    throw {
      kind: "not_utf8",
      message: "The page is not UTF-8 text, so it cannot be edited here. It has not been changed.",
    };
  }
  return { open, path, text: page };
}

/** A text's lines, without the empty one after a final newline, as Rust's `str::lines` gives them. */
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * A line diff of `disk` against `text` from their longest common subsequence: enough for the
 * preview's short pages. The core uses `similar`.
 */
function compareLines(disk: string, text: string): DiffLine[] {
  const old = linesOf(disk);
  const mine = linesOf(text);
  // common[i][j]: the length of the longest common subsequence of old[i..] and mine[j..].
  const common = Array.from({ length: old.length + 1 }, () => Array(mine.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = mine.length - 1; j >= 0; j--) {
      common[i][j] =
        old[i] === mine[j]
          ? common[i + 1][j + 1] + 1
          : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length || j < mine.length) {
    if (i < old.length && j < mine.length && old[i] === mine[j]) {
      lines.push({ kind: "same", text: old[i++] });
      j++;
    } else if (j === mine.length || (i < old.length && common[i + 1][j] >= common[i][j + 1])) {
      lines.push({ kind: "removed", text: old[i++] });
    } else {
      lines.push({ kind: "added", text: mine[j++] });
    }
  }
  return lines;
}

let changeCount = 0;

/** Records a change of the page at `path` and returns its id. */
function record(
  open: PreviewWorld,
  path: string,
  kind: VersionKind,
  before: string | null,
  after: string,
) {
  const id = ++changeCount;
  open.changes.push({ id, path, kind, at: Math.floor(Date.now() / 1000), before, after });
  return id;
}

/**
 * A page's earlier versions with their texts, newest first, as the core derives them: each change's
 * text after it, and the text before it, labelled outside, when that is not the text listed last.
 */
function versionsOf(open: PreviewWorld, path: string) {
  const versions: (HistoryVersion & { text: string })[] = [];
  const push = (id: string, kind: VersionKind, at: number, text: string | null) => {
    if (text !== null && versions.at(-1)?.text !== text) versions.push({ id, kind, at, text });
  };
  for (const change of open.changes.filter((candidate) => candidate.path === path)) {
    push(`${change.id}-before`, "outside", change.at, change.before);
    push(`${change.id}-after`, change.kind, change.at, change.after);
  }
  return versions.reverse();
}

/** Puts `text` in the page at `path` like a write of the core's, with a new version. */
function writeText(open: PreviewWorld, path: string, text: string) {
  open.pages[path] = text;
  open.saves[path] = (open.saves[path] ?? 0) + 1;
}

const conflict = {
  kind: "conflict",
  message: "The page changed on disk since it was last read or saved.",
};

const escapedForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pages that link to the page at `path`, found by scanning the other pages for `[[name]]`,
 * `[[name|…]]` and `[[name#…]]` with the page's name, in any letter case. An approximation for the
 * preview: the core's index also resolves paths and aliases, and leaves out code and frontmatter.
 */
function backlinksOf(open: PreviewWorld, path: string): Backlink[] {
  const name = path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
  const link = new RegExp(`!?\\[\\[${escapedForPattern(name)}(?:[|#][^\\]\\n]*)?\\]\\]`, "i");
  const pages: Backlink[] = [];
  for (const [source, text] of Object.entries(open.pages)) {
    if (source === path || typeof text !== "string") continue;
    const found = link.exec(text);
    if (!found) continue;
    const lineStart = text.lastIndexOf("\n", found.index) + 1;
    const lineEnd = text.indexOf("\n", found.index);
    pages.push({
      path: source,
      name: source.split("/").at(-1)?.replace(/\.md$/i, "") ?? source,
      line: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
      at: found.index,
    });
  }
  return pages.sort((a, b) => byName.compare(a.name, b.name) || byName.compare(a.path, b.path));
}

const nameOf = (path: string) => path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;

/** The first page whose name equals a link's target in any letter case, by page name only. */
function pageNamed(open: PreviewWorld, target: string) {
  const wanted = target.toLowerCase();
  return Object.keys(open.pages).find((path) => nameOf(path).toLowerCase() === wanted) ?? null;
}

const attachment =
  /\.(png|jpe?g|gif|bmp|svg|webp|avif|mp3|wav|m4a|ogg|flac|3gp|mp4|webm|ogv|mov|mkv|pdf)$/i;

/**
 * The `[[…]]` links in a page's text, found with a regular expression and resolved by page name
 * only. An approximation for the preview: the core also resolves paths and aliases, and leaves out
 * code and frontmatter.
 */
function linksOf(open: PreviewWorld, from: string, text: string): EditorLink[] {
  return [...text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)].map((found) => {
    const [part, anchor = ""] = found[1].split("|")[0].split("#");
    const target = part.trim().replace(/\.md$/i, "");
    const path = target === "" ? from : pageNamed(open, target);
    const state = attachment.test(target) ? "attachment" : path ? "resolved" : "unresolved";
    return {
      from: found.index,
      to: found.index + found[0].length,
      state,
      target,
      path: state === "resolved" ? path : null,
      heading: anchor && !anchor.startsWith("^") ? anchor.trim() : null,
      block: anchor.startsWith("^") ? anchor.slice(1).trim() : null,
    };
  });
}

/**
 * Up to 10 pages other than `from` whose name starts with the query, then those whose name holds it
 * elsewhere, each group in path order. An approximation for the preview: the core also matches
 * aliases and paths, and writes the path of a page whose name another page shares.
 */
function suggestionsOf(open: PreviewWorld, from: string, query: string): LinkSuggestions {
  const wanted = query.trim().toLowerCase();
  const paths = Object.keys(open.pages)
    .filter((path) => path !== from)
    .sort(byName.compare);
  const at = (path: string) => nameOf(path).toLowerCase().indexOf(wanted);
  const items = [...paths.filter((path) => at(path) === 0), ...paths.filter((path) => at(path) > 0)]
    .slice(0, 10)
    .map((path) => ({ path, name: nameOf(path), alias: null, insert: nameOf(path) }));
  return { indexing: false, items };
}

/**
 * A page's aliases from an `aliases:` line in its frontmatter, as a list in brackets or one name:
 * enough for the preview's pages. The core reads the frontmatter as YAML.
 */
function aliasesOf(page: SamplePage) {
  if (typeof page !== "string" || !page.startsWith("---\n")) return [];
  const frontmatter = page.slice(4, page.indexOf("\n---", 3));
  const found = /^aliases:[ \t]*(.*)$/m.exec(frontmatter);
  if (!found) return [];
  const list = found[1].trim().replace(/^\[(.*)\]$/, "$1");
  return list
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

/**
 * A text in lowercase without accents, with the range in the original text, in UTF-16 code units,
 * of the character each of its code units came from, as the core folds names.
 */
function fold(text: string) {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const character of text) {
    const end = at + character.length;
    const parts = character.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    if (parts === "" && to.length > 0) to[to.length - 1] = end;
    for (const unit of parts.split("")) {
      folded += unit;
      from.push(at);
      to.push(end);
    }
    at = end;
  }
  return { folded, from, to };
}

/** Where the folded `query` first appears in `text`: whether at its start, and the mark. */
function matchIn(text: string, query: string) {
  const { folded, from, to } = fold(text);
  const at = folded.indexOf(query);
  if (at === -1) return null;
  return { start: at === 0, mark: { from: from[at], to: to[at + query.length - 1] } };
}

/**
 * Up to 10 pages whose name or alias, or for a query with a `/` whose path without `.md`, holds
 * the query, with letter case and accents ignored: a match at the start first, then a name or path
 * before an alias, then path order. An approximation of the core's ranking for the preview.
 */
function pageMatchesOf(open: PreviewWorld, query: string): PageMatches {
  const trimmed = query.trim();
  const wanted = fold(trimmed).folded;
  if (wanted === "") return { state: "ready", pages: [] };
  type Ranked = PageMatch & { start: boolean };
  const rank = (match: Ranked) => Number(!match.start) * 2 + Number(match.field === "alias");
  const matches: Ranked[] = [];
  for (const [path, text] of Object.entries(open.pages)) {
    const name = nameOf(path);
    const candidates: Ranked[] = [];
    const add = (found: ReturnType<typeof matchIn>, rest: Omit<PageMatch, "mark">) => {
      if (found) candidates.push({ ...rest, mark: found.mark, start: found.start });
    };
    if (trimmed.includes("/")) {
      add(matchIn(path.replace(/\.md$/i, ""), wanted), { path, name, field: "path", alias: null });
    } else {
      add(matchIn(name, wanted), { path, name, field: "name", alias: null });
      for (const alias of aliasesOf(text)) {
        add(matchIn(alias, wanted), { path, name, field: "alias", alias });
      }
    }
    const best = candidates.sort((a, b) => rank(a) - rank(b))[0];
    if (best) matches.push(best);
  }
  const pages = matches
    .sort((a, b) => rank(a) - rank(b) || byName.compare(a.path, b.path))
    .slice(0, 10)
    .map(({ start: _start, ...match }) => match);
  return { state: "ready", pages };
}

/** A text's words, as the core splits them: a letter or digit, then letters, digits and marks. */
const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/**
 * Up to 10 pages, other than the query's page matches, whose text holds every word of the query as
 * the start of a word, with letter case and accents ignored, each with its first 3 lines that hold
 * a match. An approximation for the preview: the core ranks the pages by relevance and cuts long
 * lines around their first match; here they come in path order, and lines are whole.
 */
function textMatchesOf(open: PreviewWorld, query: string): TextMatches {
  const wanted = [...query.matchAll(wordPattern)]
    .map(([word]) => fold(word).folded)
    .filter(Boolean);
  if (wanted.length === 0) return { state: "ready", pages: [] };
  const matched = pageMatchesOf(open, query);
  const listed = new Set(matched.state === "failed" ? [] : matched.pages.map((page) => page.path));
  const starts = (word: string) => wanted.some((start) => fold(word).folded.startsWith(start));
  const pages: TextMatch[] = [];
  for (const path of Object.keys(open.pages).sort(byName.compare)) {
    const text = open.pages[path];
    if (typeof text !== "string" || listed.has(path)) continue;
    const words = [...text.matchAll(wordPattern)].map(([word]) => fold(word).folded);
    if (!wanted.every((start) => words.some((word) => word.startsWith(start)))) continue;
    const lines: TextLine[] = [];
    let lineAt = 0;
    for (const line of text.split("\n")) {
      const marks = [...line.matchAll(wordPattern)]
        .filter(([word]) => starts(word))
        .map((found) => ({ from: found.index, to: found.index + found[0].length }));
      if (marks.length > 0 && lines.length < 3) {
        lines.push({ text: line, at: lineAt + marks[0].from, marks });
      }
      lineAt += line.length + 1;
    }
    pages.push({ path, name: nameOf(path), lines });
  }
  return { state: "ready", pages: pages.slice(0, 10) };
}

/**
 * Creates an empty page for a query typed in search like the core: `{query}.md` in the folder of
 * `from`, or at the query's path from the top level. An approximation for the preview: it joins no
 * `./` or `../`, refuses every hidden segment, and finds an existing page by its whole path in any
 * letter case.
 */
function createSearched(args: InvokeArgs | undefined): LinkedPage {
  const open = requireWorld();
  const { from, query } = args as { from: string | null; query: string };
  const trimmed = query.trim().replace(/\.md$/i, "");
  const segments = trimmed.split("/");
  const name = segments.pop() ?? "";
  const folders = trimmed.includes("/") ? segments : (from?.split("/").slice(0, -1) ?? []);
  const folder = folders.join("/");
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  const existing = Object.keys(open.pages).find(
    (candidate) => candidate.toLowerCase() === path.toLowerCase(),
  );
  if (existing) return { state: "existing", path: existing };
  if ([...folders, name].some((segment) => segment.startsWith("."))) {
    throw { kind: "invalid_path", message: "The link does not point to a page in this world." };
  }
  for (const segment of [...folders, name]) checkName(segment);
  checkFree(namesIn(open, folder || null), `${name}.md`);
  open.pages[path] = "";
  record(open, path, "new_page", null, "");
  return { state: "created", path };
}

/** Creates an empty page for an unresolved link like the core, without `./` and `../` paths. */
function createLinked(args: InvokeArgs | undefined): LinkedPage {
  const open = requireWorld();
  const { from, target } = args as { from: string; target: string };
  const existing = pageNamed(open, target);
  if (existing) return { state: "existing", path: existing };
  const segments = target.replace(/\.md$/i, "").split("/");
  const name = segments.pop() ?? "";
  const folder = target.includes("/") ? segments.join("/") : from.split("/").slice(0, -1).join("/");
  checkName(name);
  checkFree(namesIn(open, folder || null), `${name}.md`);
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  open.pages[path] = "";
  record(open, path, "new_page", null, "");
  return { state: "created", path };
}

/** Creates an empty page or folder like the core, refusing names that break a rule or clash. */
function createEntry(args: InvokeArgs | undefined, kind: TreeEntry["kind"]) {
  const open = requireWorld();
  const { folder, name } = args as { folder: string | null; name: string };
  const isFolder = (path: string) =>
    open.folders.has(path) || Object.keys(open.pages).some((page) => page.startsWith(`${path}/`));
  if (folder !== null && !isFolder(folder)) {
    throw { kind: "not_found", message: "The page or folder does not exist." };
  }
  checkName(name);
  const fileName = kind === "page" ? `${name}.md` : name;
  checkFree(namesIn(open, folder), fileName);
  const path = folder === null ? fileName : `${folder}/${fileName}`;
  if (kind === "page") {
    open.pages[path] = "";
    record(open, path, "new_page", null, "");
  } else open.folders.add(path);
  return { path };
}

// The preview has no folder dialog: Browse… switches to the other sample location.
const previewLocations = ["/home/preview/Documents", "/home/preview/Campaigns"];
let newLocation = previewLocations[0];
/** The worlds created in each location this session, by name. */
const createdWorlds: Record<string, string[]> = {};

/** Sample command results: values, or functions of the arguments that throw like the core. */
export const previewFixtures: Record<string, unknown> = {
  // Opens the sample world at once: the preview has no folder dialog.
  world_open: (): WorldOpened => {
    remember(sampleWorld, sampleWorldPath);
    return opened(sampleWorld);
  },
  world_close: () => {
    world = null;
    return null;
  },
  world_tree: (): TreeEntry[] => treeOf(requireWorld()),
  page_read: (args?: InvokeArgs): PageText => {
    const { open, path, text } = pageText(args);
    return { text, version: versionOf(open, path) };
  },
  // Keeps saved text for as long as the preview page stays loaded.
  page_write: (args?: InvokeArgs): PageVersion => {
    const { open, path, text } = pageText(args);
    const { text: edited, version } = args as { text: string; version: string };
    if (version !== versionOf(open, path)) throw conflict;
    if (open === sampleWorld && path === lockedPage) {
      throw { kind: "io", message: "Another program is using the file." };
    }
    if (edited !== text) {
      writeText(open, path, edited);
      record(open, path, "edit", text, edited);
    }
    return { version: versionOf(open, path) };
  },
  history_list: (args?: InvokeArgs): HistoryVersion[] => {
    const { open, path, text } = pageText(args);
    const versions = versionsOf(open, path);
    const firstEarlier = versions.findIndex((version) => version.text !== text);
    return versions
      .slice(firstEarlier === -1 ? versions.length : firstEarlier)
      .map(({ id, kind, at }) => ({ id, kind, at }));
  },
  history_compare: (args?: InvokeArgs): DiffLine[] => {
    const { open, path } = pageText(args);
    const { version, text } = args as { version: string; text: string };
    const earlier = versionsOf(open, path).find((candidate) => candidate.id === version);
    if (!earlier) {
      throw { kind: "not_found", message: "This version is no longer in the page's history." };
    }
    return compareLines(earlier.text, text);
  },
  history_restore: (args?: InvokeArgs): RestoredPage => {
    const { open, path, text } = pageText(args);
    const { version, pageVersion } = args as { version: string; pageVersion: string };
    if (pageVersion !== versionOf(open, path)) throw conflict;
    const earlier = versionsOf(open, path).find((candidate) => candidate.id === version);
    if (!earlier) {
      throw { kind: "not_found", message: "This version is no longer in the page's history." };
    }
    if (earlier.text === text) return { text, version: versionOf(open, path), change: null };
    writeText(open, path, earlier.text);
    const change = record(open, path, "restore", text, earlier.text);
    return { text: earlier.text, version: versionOf(open, path), change: String(change) };
  },
  history_undo: (args?: InvokeArgs): RestoredPage => {
    const open = requireWorld();
    const { change } = args as { change: string };
    const undone = open.changes.find((candidate) => String(candidate.id) === change);
    if (!undone || undone.before === null) {
      throw { kind: "not_found", message: "This change cannot be undone." };
    }
    if (open.pages[undone.path] !== undone.after) {
      const name = undone.path.split("/").at(-1)?.replace(/\.md$/i, "");
      throw {
        kind: "conflict",
        message: `“${name}” changed since the restore, so nothing was undone. Its history still holds every version.`,
      };
    }
    writeText(open, undone.path, undone.before);
    const id = record(open, undone.path, "undo", undone.after, undone.before);
    return { text: undone.before, version: versionOf(open, undone.path), change: String(id) };
  },
  // The preview simulates no outside changes, so neither is reached from its pages; both answer
  // like the core.
  page_compare: (args?: InvokeArgs): Comparison => {
    const { open, path, text } = pageText(args);
    const { text: mine } = args as { text: string };
    return { version: versionOf(open, path), lines: compareLines(text, mine) };
  },
  page_restore: (args?: InvokeArgs): { version: string } => {
    const open = requireWorld();
    const { path, text } = args as { path: string; text: string };
    if (Object.hasOwn(open.pages, path)) {
      throw {
        kind: "conflict",
        message: "Something is at the page's path again, so it was not restored.",
      };
    }
    open.pages[path] = text;
    return { version: versionOf(open, path) };
  },
  page_create: (args?: InvokeArgs) => createEntry(args, "page"),
  folder_create: (args?: InvokeArgs) => createEntry(args, "folder"),
  world_new_location: () => {
    newLocation = previewLocations[0];
    return { location: newLocation };
  },
  world_new_browse: () => {
    newLocation = previewLocations[1];
    return { location: newLocation };
  },
  world_create: (args?: InvokeArgs): WorldOpened => {
    const { name } = args as { name: string };
    checkName(name);
    const created = createdWorlds[newLocation] ?? [];
    checkFree(created, name);
    createdWorlds[newLocation] = [...created, name];
    const next = emptyWorld(name);
    remember(next, `${newLocation}/${name}`);
    return opened(next);
  },
  // The preview always launches on the welcome screen.
  world_restore: () => null,
  recent_list: (): RecentWorld[] =>
    recentWorlds
      .filter((recent) => world === null || recent.world !== world)
      .map(({ world: _world, ...recent }) => recent),
  recent_remove: (args?: InvokeArgs) => {
    const { id } = args as { id: string };
    recentWorlds = recentWorlds.filter((recent) => recent.id !== id);
    return null;
  },
  world_open_recent: (args?: InvokeArgs): WorldOpened => {
    const { id } = args as { id: string };
    const recent = recentWorlds.find((entry) => entry.id === id);
    if (!recent) {
      throw { kind: "not_found", message: "This world is no longer in the recent list." };
    }
    if (!recent.world) {
      throw { kind: "world_missing", message: "The world's folder cannot be found." };
    }
    remember(recent.world, recent.path);
    return opened(recent.world);
  },
  workspace_save: () => null,
  app_close: () => null,
  backlinks_list: (args?: InvokeArgs): Backlinks => {
    const { path } = args as { path: string };
    return { state: "ready", pages: backlinksOf(requireWorld(), path) };
  },
  links_in: (args?: InvokeArgs): EditorLinks => {
    const { path, text } = args as { path: string; text: string };
    return { state: "ready", links: linksOf(requireWorld(), path, text) };
  },
  link_create: (args?: InvokeArgs) => createLinked(args),
  link_suggest: (args?: InvokeArgs) => {
    const { from, query } = args as { from: string; query: string };
    return suggestionsOf(requireWorld(), from, query);
  },
  search_pages: (args?: InvokeArgs) => {
    const { query } = args as { query: string };
    return pageMatchesOf(requireWorld(), query);
  },
  search_text: (args?: InvokeArgs) => {
    const { query } = args as { query: string };
    return textMatchesOf(requireWorld(), query);
  },
  search_create: (args?: InvokeArgs) => createSearched(args),
};
