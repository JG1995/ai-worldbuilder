//! Builds a request's messages: one system message with the instructions, the world's name and the
//! chosen pages, then the earlier messages that fit their budget, then the new message.

use super::ContextPage;
use super::context::{Context, EARLIER_LIMIT};
use super::store::Message;
use crate::providers::{ChatMessage, Role};

const INSTRUCTIONS: &str = "You help the user build the fictional world named below. \
The pages that follow are the world's established canon: rely on them, and say so when they do \
not answer something. When you name a page of the world, write its name as a link in double \
square brackets, such as [[Saltmere]]. You cannot change pages; only the user can.";

/// A request's messages, and what its context event tells: the pages it carries, how many earlier
/// messages it leaves out, and whether the index was still being built. All come from this one
/// value.
#[derive(Debug)]
pub struct Request {
    pub messages: Vec<ChatMessage>,
    pub pages: Vec<ContextPage>,
    pub left_out: u32,
    pub indexing: bool,
}

/// The request for `new`, sent in the world `world_name` with the pages of `context`, after
/// `earlier` messages.
pub fn build(world_name: &str, context: &Context, earlier: &[Message], new: &str) -> Request {
    let pages = &context.pages;
    let mut system = format!("{INSTRUCTIONS}\n\nThe world: {world_name}");
    for page in pages {
        let read = match page.partial {
            true => " (only its beginning)",
            false => "",
        };
        system.push_str(&format!(
            "\n\n--- Page {}{read} ---\n{}",
            page.path, page.text
        ));
    }
    // An answer stopped before any text has nothing to send, and some providers refuse it.
    let earlier: Vec<&Message> = earlier
        .iter()
        .filter(|message| !message.text.is_empty())
        .collect();
    let kept = &earlier[earlier.len() - fitting(&earlier)..];
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    messages.extend(kept.iter().map(|message| ChatMessage {
        role: match message.answer {
            Some(_) => Role::Assistant,
            None => Role::User,
        },
        content: message.text.clone(),
    }));
    messages.push(ChatMessage {
        role: Role::User,
        content: new.to_owned(),
    });
    Request {
        messages,
        pages: pages
            .iter()
            .map(|page| ContextPage {
                path: page.path.clone(),
                partial: page.partial,
            })
            .collect(),
        left_out: (earlier.len() - kept.len()) as u32,
        indexing: context.indexing,
    }
}

/// How many of the latest `earlier` messages fit in `EARLIER_LIMIT` characters, taken newest
/// first; a message that does not fit leaves out every older one.
fn fitting(earlier: &[&Message]) -> usize {
    let mut used = 0;
    earlier
        .iter()
        .rev()
        .take_while(|message| {
            used += message.text.chars().count();
            used <= EARLIER_LIMIT
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::store::AnswerState;

    fn message(text: String, answer: Option<AnswerState>) -> Message {
        Message { text, answer }
    }

    #[test]
    fn earlier_messages_fill_their_budget_newest_first_and_keep_their_order() {
        // The newest message's characters take four bytes each: the budget counts characters.
        let text = |letter: char| letter.to_string().repeat(10_000);
        let earlier = [
            message(text('a'), None),
            message(text('b'), Some(AnswerState::Complete)),
            message(text('c'), None),
            message(text('d'), Some(AnswerState::Stopped)),
            message("🜁".repeat(2_000), None),
        ];

        let request = build("Kesh", &Context::default(), &earlier, "Now?");

        let roles: Vec<(Role, char)> = request
            .messages
            .iter()
            .map(|message| (message.role, message.content.chars().next().unwrap()))
            .collect();
        assert_eq!(
            roles,
            [
                (Role::System, 'Y'),
                (Role::Assistant, 'b'),
                (Role::User, 'c'),
                (Role::Assistant, 'd'),
                (Role::User, '🜁'),
                (Role::User, 'N'),
            ]
        );
        assert_eq!(request.left_out, 1);
        assert!(request.messages[0].content.contains("The world: Kesh"));
    }

    #[test]
    fn answers_stopped_before_any_text_are_neither_sent_nor_left_out() {
        // Providers such as Anthropic refuse an empty earlier message.
        let earlier = [
            message("Older".to_owned(), None),
            message(String::new(), Some(AnswerState::Stopped)),
            message("a".repeat(EARLIER_LIMIT), None),
            message("Brief.".to_owned(), Some(AnswerState::Complete)),
            message("Again?".to_owned(), None),
            message(String::new(), Some(AnswerState::Stopped)),
        ];

        let request = build("Kesh", &Context::default(), &earlier, "Now?");

        let sent: Vec<(Role, &str)> = request.messages[1..]
            .iter()
            .map(|message| (message.role, message.content.as_str()))
            .collect();
        assert_eq!(
            sent,
            [
                (Role::Assistant, "Brief."),
                (Role::User, "Again?"),
                (Role::User, "Now?"),
            ]
        );
        assert_eq!(request.left_out, 2);
    }
}
