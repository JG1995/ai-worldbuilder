//! The tree's sort order, shared by the `world` area's tree and the `index` area's resolution,
//! suggestions and backlinks.

use std::cmp::Ordering;
use std::iter::Peekable;
use std::str::Chars;

/// Compares names ignoring letter case (Unicode lowercase), with runs of digits compared as numbers.
pub fn natural_order(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        let ordering = match (a.peek(), b.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (x, y) = (digits(&mut a), digits(&mut b));
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                x.len().cmp(&y.len()).then_with(|| x.cmp(y))
            }
            (Some(x), Some(y)) => {
                let ordering = x.cmp(y);
                a.next();
                b.next();
                ordering
            }
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
}

fn digits(chars: &mut Peekable<Chars>) -> String {
    let mut run = String::new();
    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
        run.push(digit);
    }
    run
}

/// Compares two page paths, relative to the world with `/` separators, in the tree's order: segment
/// by segment, and at the first segment that differs, a folder (any segment but the last) comes
/// before a page, and otherwise names compare in `natural_order`, a page's without its extension.
/// Paths that differ only in letter case compare by their bytes, so the order is total.
pub fn path_order(a: &str, b: &str) -> Ordering {
    let (mut a_segments, mut b_segments) = (a.split('/').peekable(), b.split('/').peekable());
    loop {
        let (Some(x), Some(y)) = (a_segments.next(), b_segments.next()) else {
            return a.cmp(b);
        };
        if x == y {
            continue;
        }
        let (x_page, y_page) = (a_segments.peek().is_none(), b_segments.peek().is_none());
        return x_page
            .cmp(&y_page)
            .then_with(|| natural_order(page_name(x, x_page), page_name(y, y_page)))
            .then_with(|| a.cmp(b));
    }
}

/// A segment's name as the tree shows it: a page's without its `.md`.
fn page_name(segment: &str, page: bool) -> &str {
    let len = segment.len();
    if page && len >= 3 && segment.is_char_boundary(len - 3) {
        &segment[..len - 3]
    } else {
        segment
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(paths: &[&'static str]) -> Vec<&'static str> {
        let mut paths = paths.to_vec();
        paths.sort_by(|a, b| path_order(a, b));
        paths
    }

    #[test]
    fn natural_order_ignores_case_and_compares_numbers_by_value() {
        assert_eq!(natural_order("Act 2", "act 10"), Ordering::Less);
        assert_eq!(natural_order("act 010", "Act 10"), Ordering::Equal);
        assert_eq!(natural_order("Alpha", "beta"), Ordering::Less);
    }

    #[test]
    fn path_order_puts_folders_before_pages_at_the_first_difference_then_natural_order() {
        assert_eq!(
            sorted(&[
                "Atlas.md",
                "Lore/x.md",
                "Kesh.md",
                "Kesh Tor.md",
                "Act 10.md",
                "Act 2.md",
                "Lore/Deep/y.md",
                "lore/a.md",
            ]),
            [
                "Lore/Deep/y.md",
                "Lore/x.md",
                "lore/a.md",
                "Act 2.md",
                "Act 10.md",
                "Atlas.md",
                "Kesh.md",
                "Kesh Tor.md",
            ]
        );
    }
}
