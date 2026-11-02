import { useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import type { AnswerEnd, AnswerEvent, ContextPage } from "@/types/api";
import {
  type AnswerFailure,
  type AnswerState,
  AssistantPane,
  type ChatMessage,
} from "@/ui/AssistantPane";
import { assistantSend, assistantStop } from "../api/commands";

/** What the assistant gets from the open world. */
export type AssistantPorts = {
  /** The world's session; a new session starts an empty conversation. */
  session: number;
  /** The active tab's page, which a request carries as context. */
  activePage: string | null;
  /** Opens a page by the tree's tab rules: in the current tab, or in a new one. */
  openPage: (path: string, options: { newTab: boolean }) => void;
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
  context: { pages: ContextPage[]; leftOut: number } | null;
  failure: AnswerFailure | null;
};

type Message = UserMessage | AnswerMessage;

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

  function updateAnswer(id: number, change: (answer: AnswerMessage) => AnswerMessage) {
    setMessages((current) =>
      current.map((message) =>
        message.id === id && message.role === "answer" ? change(message) : message,
      ),
    );
  }

  function newAnswer(): AnswerMessage {
    const id = nextId.current++;
    return { id, role: "answer", text: "", state: "streaming", context: null, failure: null };
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
        const context = { pages: event.pages, leftOut: event.leftOut };
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

  /** The message as the pane shows it, with each context page marked when the world lost it. */
  function shown(message: Message): ChatMessage {
    if (message.role === "user") return message;
    if (!message.context) return { ...message, context: null };
    const { pages, leftOut } = message.context;
    const marked = pages.map((page) => ({ ...page, gone: !ports.hasPage(page.path) }));
    return { ...message, context: { pages: marked, leftOut } };
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
        refusal,
        announcement,
      }}
    />
  );
}
