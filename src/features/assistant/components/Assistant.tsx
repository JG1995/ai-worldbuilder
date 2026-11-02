import { useEffect, useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import type { AnswerEnd, AnswerEvent, ContextPage, EditorLink } from "@/types/api";
import {
  type AnswerFailure,
  type AnswerState,
  AssistantPane,
  type ChatMessage,
} from "@/ui/AssistantPane";
import type { LinkAnchor } from "@/ui/editor-links";
import { assistantLinks, assistantSend, assistantStop } from "../api/commands";

/** What the assistant gets from the open world. */
export type AssistantPorts = {
  /** The world's session; a new session starts an empty conversation. */
  session: number;
  /** The active tab's page, which a request carries as context. */
  activePage: string | null;
  /**
   * Opens a page by the tree's tab rules: in the current tab, or in a new one, with the cursor at
   * `at` if the page has it.
   */
  openPage: (path: string, options: { newTab: boolean; at?: LinkAnchor }) => void;
  /** Changes whenever what the world's index holds changes. */
  indexRevision: number;
  /** Resolves once the active page's pending edits are saved, or have failed to save. */
  flushActive: () => Promise<void>;
  /** Whether the world still has the page at `path`. */
  hasPage: (path: string) => boolean;
};

type AssistantProps = {
  ports: AssistantPorts;
  /** The saved text provider's model. Without it, no provider is saved. */
  model?: string;
  /** The saved text provider's host. */
  host?: string;
  onOpenSettings: () => void;
};

type UserMessage = { id: number; role: "user"; text: string };

type AnswerMessage = {
  id: number;
  role: "answer";
  text: string;
  state: AnswerState;
  context: { pages: ContextPage[]; leftOut: number; indexing: boolean } | null;
  failure: AnswerFailure | null;
  /** The links the core found in `text`, which are stale once the text differs. */
  linked: { text: string; links: readonly EditorLink[] } | null;
};

type Message = UserMessage | AnswerMessage;

/** `messages` with the answer `id` changed by `change`. */
function withAnswer(
  messages: Message[],
  id: number,
  change: (answer: AnswerMessage) => AnswerMessage,
): Message[] {
  return messages.map((message) =>
    message.id === id && message.role === "answer" ? change(message) : message,
  );
}

const announcements: Record<AnswerEnd["state"], string> = {
  complete: "The answer is complete.",
  stopped: "The answer was stopped.",
  cut_off: "The answer was cut off because it was too long.",
  failed: "The answer failed.",
};

/**
 * The assistant's conversation in this world: it sends a message, or the last one again, with the
 * active page's path, shows the answer as it arrives, and stops it on Stop. The core keeps the
 * conversation; only the new message and the active page's path go to it.
 */
export function Assistant({ ports, model, host, onOpenSettings }: AssistantProps) {
  const [conversation, setConversation] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const nextId = useRef(0);
  /** For each answer, the index revision and text its links were last asked for. */
  const linksAsked = useRef(new Map<number, string>());
  const { indexRevision } = ports;

  function updateAnswer(id: number, change: (answer: AnswerMessage) => AnswerMessage) {
    setMessages((current) => withAnswer(current, id, change));
  }

  // Each answer's links, once its text is final, and again for every answer when the index
  // changes. An answer asked while the index is built stays plain until then.
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "answer" || message.state === "streaming" || message.text === "") {
        continue;
      }
      const { id, text } = message;
      const asked = `${indexRevision}:${text}`;
      if (linksAsked.current.get(id) === asked) continue;
      linksAsked.current.set(id, asked);
      assistantLinks(text).then(
        (found) => {
          if (linksAsked.current.get(id) !== asked) return;
          const links = found.state === "ready" ? found.links : [];
          setMessages((current) =>
            withAnswer(current, id, (shown) => ({ ...shown, linked: { text, links } })),
          );
        },
        // Without an answer, such as with AI just switched off, the text stays as it is.
        () => {},
      );
    }
  }, [messages, indexRevision]);

  function newAnswer(): AnswerMessage {
    const id = nextId.current++;
    return {
      id,
      role: "answer",
      text: "",
      state: "streaming",
      context: null,
      failure: null,
      linked: null,
    };
  }

  /**
   * Saves the active page, then asks the core to answer into `answer`. A refusal, which comes
   * before the core has saved anything, goes to `refused` with the core's message.
   */
  async function request(
    answer: AnswerMessage,
    outgoing: { text: string; retry: boolean },
    refused: (message: string) => void,
  ) {
    setRefusal(null);
    setAnnouncement("");
    await ports.flushActive();
    // Text that arrives after the answer has ended is dropped: the end carries the final text.
    const onEvent = (event: AnswerEvent) => {
      if (event.kind === "context") {
        const context = {
          pages: event.pages,
          leftOut: event.leftOut,
          indexing: event.indexing,
        };
        updateAnswer(answer.id, (shown) => ({ ...shown, context }));
      } else {
        updateAnswer(answer.id, (shown) =>
          shown.state === "streaming" ? { ...shown, text: shown.text + event.delta } : shown,
        );
      }
    };
    let end: AnswerEnd;
    try {
      end = await assistantSend(
        { conversation, text: outgoing.text, active: ports.activePage, retry: outgoing.retry },
        onEvent,
      );
    } catch (error) {
      refused((error as IpcError).message);
      return;
    }
    setConversation(end.conversation);
    const failure =
      end.state === "failed"
        ? { reason: end.reason, detail: end.detail, providerMessage: end.providerMessage }
        : null;
    updateAnswer(answer.id, (shown) => ({ ...shown, text: end.text, state: end.state, failure }));
    setAnnouncement(announcements[end.state]);
  }

  function send() {
    const text = draft;
    const user: UserMessage = { id: nextId.current++, role: "user", text };
    const answer = newAnswer();
    setMessages((current) => [...current, user, answer]);
    setDraft("");
    void request(answer, { text, retry: false }, (message) => {
      // Nothing was saved: the message goes back into the composer.
      setMessages((current) => current.filter(({ id }) => id !== user.id && id !== answer.id));
      setDraft((current) => (current === "" ? text : current));
      setRefusal(`The message could not be sent: ${message}`);
    });
  }

  function retry() {
    const failed = messages.at(-1);
    if (failed?.role !== "answer") return;
    const answer = newAnswer();
    setMessages((current) => [...current.slice(0, -1), answer]);
    void request(answer, { text: "", retry: true }, (message) => {
      setMessages((current) => current.map((shown) => (shown.id === answer.id ? failed : shown)));
      setRefusal(`The message could not be sent again: ${message}`);
    });
  }

  /**
   * The message as the pane shows it, with each context page marked when the world lost it, and
   * the links of its current text.
   */
  function shown(message: Message): ChatMessage {
    if (message.role === "user") return message;
    const { linked, context, ...answer } = message;
    const links = linked?.text === message.text ? linked.links : undefined;
    if (!context) return { ...answer, context: null, links };
    const marked = context.pages.map((page) => ({ ...page, gone: !ports.hasPage(page.path) }));
    return { ...answer, context: { ...context, pages: marked }, links };
  }

  /**
   * Opens the page a followed link in an answer resolved to, in a new tab at its heading or block.
   * Answers are untrusted: a link to no page does nothing and never creates one.
   */
  function follow(link: EditorLink) {
    if (link.state !== "resolved" || link.path === null) return;
    ports.openPage(link.path, { newTab: true, at: { heading: link.heading, block: link.block } });
  }

  function copy(text: string) {
    setAnnouncement("");
    // `navigator.clipboard` is missing outside a secure context, which a rejection reports too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setAnnouncement("Copied"),
        () => setAnnouncement("The answer could not be copied."),
      );
  }

  return (
    <AssistantPane
      model={model}
      host={host}
      onOpenSettings={onOpenSettings}
      chat={{
        messages: messages.map(shown),
        draft,
        onDraftChange: setDraft,
        onSend: send,
        // The answer then ends as stopped, through its own request. A refusal, such as with AI
        // just switched off, leaves nothing to stop.
        onStop: () => void assistantStop().catch(() => {}),
        onRetry: retry,
        onOpenPage: ports.openPage,
        onFollowLink: follow,
        onCopy: copy,
        refusal,
        announcement,
      }}
    />
  );
}
