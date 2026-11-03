//! A page's frontmatter as the reading view's properties block shows it.
//!
//! The frontmatter is found and guarded as `parse` finds and guards it for aliases: YAML that is
//! not valid, nests too deep or holds an alias is not loaded, and shows as typed.

use serde::Serialize;
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use super::parse::{frontmatter, loadable};

/// What the properties block shows for a page's text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Properties {
    /// The frontmatter's properties, in the order they are written.
    Rows { rows: Vec<Property> },
    /// The frontmatter is not a YAML map that can be read; it shows as typed.
    Source,
    /// The page has no frontmatter, or frontmatter with no property.
    None,
}

/// One property: its key, as text, and its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Property {
    pub key: String,
    pub value: PropertyValue,
}

/// A property's value as it shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PropertyValue {
    /// A string, number or boolean. YAML 1.2 has no date type, so a date is a string.
    Text { text: String },
    /// A list of those.
    List { items: Vec<String> },
    /// Anything else, such as a map or a list of maps, as its YAML text.
    Yaml { text: String },
    /// No value.
    Empty,
}

/// The properties of the page whose text is `text`.
pub fn properties(text: &str) -> Properties {
    let Some((body, _)) = frontmatter(text) else {
        return Properties::None;
    };
    if !loadable(body) {
        return Properties::Source;
    }
    let Ok(documents) = YamlLoader::load_from_str(body) else {
        return Properties::Source;
    };
    let Some(document) = documents.first() else {
        return Properties::None;
    };
    let Yaml::Hash(map) = document else {
        return Properties::Source;
    };
    if map.is_empty() {
        return Properties::None;
    }
    let rows = map
        .iter()
        .map(|(key, value)| Property {
            key: scalar(key).unwrap_or_else(|| emitted(key)),
            value: value_of(value),
        })
        .collect();
    Properties::Rows { rows }
}

fn value_of(value: &Yaml) -> PropertyValue {
    if matches!(value, Yaml::Null) {
        return PropertyValue::Empty;
    }
    if let Some(text) = scalar(value) {
        return PropertyValue::Text { text };
    }
    if let Yaml::Array(items) = value
        && let Some(items) = items.iter().map(scalar).collect::<Option<Vec<_>>>()
    {
        return PropertyValue::List { items };
    }
    PropertyValue::Yaml {
        text: emitted(value),
    }
}

/// A string, number or boolean as text, as it was written for a real number.
fn scalar(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(text) | Yaml::Real(text) => Some(text.clone()),
        Yaml::Integer(number) => Some(number.to_string()),
        Yaml::Boolean(value) => Some(value.to_string()),
        _ => None,
    }
}

/// `value` written as YAML, without the document marker the emitter starts with.
fn emitted(value: &Yaml) -> String {
    let mut text = String::new();
    // Writing to a String fails only on a value the loader never builds, such as an alias.
    if YamlEmitter::new(&mut text).dump(value).is_err() {
        return String::new();
    }
    text.strip_prefix("---\n")
        .or_else(|| text.strip_prefix("--- "))
        .unwrap_or(&text)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(text: &str) -> PropertyValue {
        PropertyValue::Text {
            text: text.to_owned(),
        }
    }

    fn rows(rows: &[(&str, PropertyValue)]) -> Properties {
        Properties::Rows {
            rows: rows
                .iter()
                .map(|(key, value)| Property {
                    key: (*key).to_owned(),
                    value: value.clone(),
                })
                .collect(),
        }
    }

    #[test]
    fn scalars_show_as_text_and_lists_of_them_as_lists() {
        let page = "---\nname: Mira\nage: 41\nheight: 1.70\nalive: true\nborn: 2026-11-03\n\
                    aliases: [Mira of Saltmere, The Tide]\nnotes:\n---\nBody";
        assert_eq!(
            properties(page),
            rows(&[
                ("name", text("Mira")),
                ("age", text("41")),
                ("height", text("1.70")),
                ("alive", text("true")),
                ("born", text("2026-11-03")),
                (
                    "aliases",
                    PropertyValue::List {
                        items: vec!["Mira of Saltmere".to_owned(), "The Tide".to_owned()],
                    },
                ),
                ("notes", PropertyValue::Empty),
            ])
        );
    }

    #[test]
    fn nested_values_and_other_keys_show_as_their_yaml() {
        let page = "---\nhome:\n  town: Saltmere\n  street: Dock Row\nkin:\n  - name: Ada\n\
                    7: seven\n---\n";
        assert_eq!(
            properties(page),
            rows(&[
                (
                    "home",
                    PropertyValue::Yaml {
                        text: "town: Saltmere\nstreet: Dock Row".to_owned(),
                    },
                ),
                (
                    "kin",
                    PropertyValue::Yaml {
                        text: "- name: Ada".to_owned(),
                    },
                ),
                ("7", text("seven")),
            ])
        );
    }

    #[test]
    fn frontmatter_that_is_not_a_readable_map_shows_as_typed() {
        let deep = format!("---\nkey: {}{}\n---\n", "[".repeat(80), "]".repeat(80));
        for page in [
            "---\nname: [unclosed\n---\n",
            "---\n- a\n- b\n---\n",
            "---\nfirst: &n Mira\nsecond: *n\n---\n",
            deep.as_str(),
        ] {
            assert_eq!(properties(page), Properties::Source, "{page}");
        }
    }

    #[test]
    fn an_anchor_without_an_alias_reads_like_any_value() {
        assert_eq!(
            properties("---\nname: &n Mira\n---\n"),
            rows(&[("name", text("Mira"))])
        );
    }

    #[test]
    fn no_frontmatter_or_no_property_shows_no_block() {
        for page in [
            "Body only",
            "---\n---\nBody",
            "---\n# a comment\n---\n",
            "---\n{}\n---\n",
        ] {
            assert_eq!(properties(page), Properties::None, "{page}");
        }
    }
}
