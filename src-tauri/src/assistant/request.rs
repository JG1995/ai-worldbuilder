//! Builds a request's messages: one system message with the instructions, the world's name and the
//! chosen pages, then the earlier messages that fit their budget, then the new message.

use super::ContextPage;
use super::context::{Context, EARLIER_LIMIT};
use super::store::{Message, Regenerated};
use crate::providers::{ChatMessage, Role};

const INSTRUCTIONS: &str = "You help the user build the fictional world named below. \
The pages that follow are the world's established canon: rely on them, and say so when they do \
not answer something. When you name a page of the world, write its name as a link in double \
square brackets, such as [[Saltmere]].

You can propose new pages and edits to existing pages, but only when the user asks for pages to \
be written or changed. Nothing is written until the user reviews and accepts each proposal. Write \
each proposal in this form, with every opening and closing tag at the start of a line. A path \
starts at the world's top level; put a new page in the folder of related pages. A new page holds \
its full text:

<new_page path=\"Places/Kesh Tor.md\">
# Kesh Tor
A hill fort above the marsh.
</new_page>

An edit changes an existing page. Each <find> quotes a passage of the page's current text \
exactly, and only once; its <replace> gives the new text, and an empty <replace> removes the \
passage:

<edit path=\"People/Mirela.md\">
<find>Mirela commands the Gull.</find>
<replace>Mirela commanded the Gull until her capture.</replace>
</edit>

Lines such as [Proposed new page \"Places/Kesh Tor.md\": accepted] record your earlier proposals \
and what became of them; never write them yourself.";

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
/// `earlier` messages. A `new` message that regenerates an image asks for it as `regenerated`
/// describes.
pub fn build(
    world_name: &str,
    context: &Context,
    earlier: &[Message],
    new: &str,
    regenerated: Option<&Regenerated>,
) -> Request {
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
    // An answer stopped before any text or proposal has nothing to send, and some providers
    // refuse it.
    let earlier: Vec<ChatMessage> = earlier
        .iter()
        .map(|message| ChatMessage {
            role: match message.answer {
                Some(_) => Role::Assistant,
                None => Role::User,
            },
            content: content(message),
        })
        .filter(|message| !message.content.is_empty())
        .collect();
    let kept = &earlier[earlier.len() - fitting(&earlier)..];
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    messages.extend_from_slice(kept);
    messages.push(ChatMessage {
        role: Role::User,
        content: match regenerated {
            Some(regenerated) => regeneration(regenerated, new),
            None => new.to_owned(),
        },
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

/// What a regeneration message sends: the earlier image's name and prompt, how to revise it, and
/// the user's `change`.
fn regeneration(regenerated: &Regenerated, change: &str) -> String {
    let Regenerated { name, prompt, .. } = regenerated;
    format!(
        "Regenerate the image \"{name}\", whose prompt was:\n\n{prompt}\n\nRevise that prompt, \
         changing only what I ask for below, and request exactly one image with the revised \
         prompt.\n\nWhat to change: {change}"
    )
}

/// What an earlier message sends: its text, followed for an answer by one line per proposal and
/// then one line per image.
fn content(message: &Message) -> String {
    let lines: Vec<&str> = message
        .proposals
        .iter()
        .chain(&message.images)
        .map(String::as_str)
        .collect();
    let mut content = message.text.clone();
    if !content.is_empty() && !lines.is_empty() {
        content.push_str("\n\n");
    }
    content.push_str(&lines.join("\n"));
    content
}

/// How many of the latest `earlier` messages fit in `EARLIER_LIMIT` characters, taken newest
/// first; a message that does not fit leaves out every older one.
fn fitting(earlier: &[ChatMessage]) -> usize {
    let mut used = 0;
    earlier
        .iter()
        .rev()
        .take_while(|message| {
            used += message.content.chars().count();
            used <= EARLIER_LIMIT
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::store::AnswerState;

    fn message(text: String, answer: Option<AnswerState>) -> Message {
        Message {
            text,
            answer,
            proposals: Vec::new(),
            images: Vec::new(),
        }
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

        let request = build("Kesh", &Context::default(), &earlier, "Now?", None);

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

        let request = build("Kesh", &Context::default(), &earlier, "Now?", None);

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

    #[test]
    fn earlier_answers_send_their_proposals_and_then_their_images_as_lines_after_their_text() {
        let line = "[Proposed new page \"Places/Kesh Tor.md\": accepted]";
        let image = "[Image \"Gull\": saved as images/Gull.png]";
        let with = |text: &str, proposals: &[&str], images: &[&str]| Message {
            text: text.to_owned(),
            answer: Some(AnswerState::Complete),
            proposals: proposals.iter().map(|line| (*line).to_owned()).collect(),
            images: images.iter().map(|line| (*line).to_owned()).collect(),
        };
        let earlier = [
            with(
                "Here it is.",
                &[line, "[Proposed edit of \"A.md\": undone]"],
                &[image, "[Image \"Tern\": pending]"],
            ),
            with("", &[line], &[]),
            with("", &[], &[image]),
        ];

        let request = build("Kesh", &Context::default(), &earlier, "Now?", None);

        let sent: Vec<&str> = request.messages[1..4]
            .iter()
            .map(|message| message.content.as_str())
            .collect();
        assert_eq!(
            sent,
            [
                format!(
                    "Here it is.\n\n{line}\n[Proposed edit of \"A.md\": undone]\n{image}\n\
                     [Image \"Tern\": pending]"
                )
                .as_str(),
                line,
                image,
            ]
        );
        assert!(request.messages[0].content.contains("<edit path="));
    }
}
