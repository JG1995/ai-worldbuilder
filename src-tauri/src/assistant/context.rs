//! Chooses the pages a message's request carries. For now that is the active page alone. The
//! request's budgets live here, counted in characters (Unicode scalar values).

use crate::world::WorldState;

/// The most characters of one page that a request carries.
pub const PAGE_LIMIT: usize = 12_000;
/// The most characters of earlier messages that a request carries.
pub const EARLIER_LIMIT: usize = 32_000;

/// A page as the request carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChosenPage {
    pub path: String,
    pub text: String,
    /// Whether the text was cut, so only part of the page was read.
    pub partial: bool,
}

/// The pages for a message sent in the opening `session` while `active` was the active page: the
/// active page, when it can be read as UTF-8 while that session is open, cut to `PAGE_LIMIT`.
pub fn choose(world: &WorldState, session: u64, active: Option<&str>) -> Vec<ChosenPage> {
    let Some(path) = active else {
        return Vec::new();
    };
    let Ok(text) = world.read_page_in(session, path) else {
        return Vec::new();
    };
    let (text, partial) = cut(text, PAGE_LIMIT);
    vec![ChosenPage {
        path: path.to_owned(),
        text,
        partial,
    }]
}

/// `text` cut to its first `limit` characters, and whether it was cut.
fn cut(mut text: String, limit: usize) -> (String, bool) {
    match text.char_indices().nth(limit) {
        Some((at, _)) => {
            text.truncate(at);
            (text, true)
        }
        None => (text, false),
    }
}
