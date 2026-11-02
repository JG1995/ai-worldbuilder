import { invokeCommand, invokeStreaming } from "@/lib/ipc";
import type { AnswerEnd, AnswerEvent, EditorLinks } from "@/types/api";

type Outgoing = {
  /** The conversation to continue, or null to start one with this message. */
  conversation: number | null;
  /** The new message. Ignored by a retry, which answers the conversation's last message again. */
  text: string;
  /** The active page's path, which the request carries as context. */
  active: string | null;
  retry: boolean;
};

/**
 * Sends a message, or with `retry` the conversation's last message again, and streams its answer:
 * the pages the request carries, then the answer's text, through `onEvent`. Once the message is
 * saved, it resolves with how the answer ended, even when no request left. Rejects before that
 * with `ai_off`, `no_world`, `invalid_path` for a refused active path, `not_found` without a
 * provider or with nothing to retry, `conflict` while an answer runs or for a retry after a
 * complete answer, and `invalid_name` for an empty message.
 */
export const assistantSend = (outgoing: Outgoing, onEvent: (event: AnswerEvent) => void) =>
  invokeStreaming<AnswerEnd, AnswerEvent>("assistant_send", outgoing, onEvent);

/** Stops the running answer, if any, and resolves once its text is saved as stopped. */
export const assistantStop = () => invokeCommand<void>("assistant_stop");

/**
 * The links of an answer's text, each with the page it resolves to as on a page at the world's top
 * level, or `not_ready` while the index is being built. Rejects with `ai_off` and `no_world`.
 */
export const assistantLinks = (text: string) =>
  invokeCommand<EditorLinks>("assistant_links", { text });
