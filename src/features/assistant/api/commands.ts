import { invokeCommand, invokeStreaming } from "@/lib/ipc";
import type {
  Accepted,
  AnswerEnd,
  AnswerEvent,
  AnswerReview,
  Conversation,
  ConversationImages,
  Conversations,
  EditorLinks,
  ImageApproved,
  ProposalVersion,
  Undone,
} from "@/types/api";

type Outgoing = {
  /** The conversation to continue, or null to start one with this message. */
  conversation: number | null;
  /** The new message. Ignored by a retry, which answers the conversation's last message again. */
  text: string;
  /** The active page's path, which the request carries as context. */
  active: string | null;
  retry: boolean;
  /** The image of the conversation that the new message regenerates, when it is a regeneration. */
  regenerates?: number;
};

/**
 * Sends a message, or with `retry` the conversation's last message again, and streams its answer:
 * the pages the request carries, then the answer's text, through `onEvent`. Once the message is
 * saved, it resolves with how the answer ended, even when no request left. Rejects before that
 * with `ai_off`, `no_world`, `invalid_path` for a refused active path, `not_found` without a
 * provider, with nothing to retry or with a `regenerates` image not of the conversation,
 * `conflict` while an answer runs or for a retry after a complete answer, and `invalid_name` for
 * an empty message.
 */
export const assistantSend = (outgoing: Outgoing, onEvent: (event: AnswerEvent) => void) =>
  invokeStreaming<AnswerEnd, AnswerEvent>("assistant_send", outgoing, onEvent);

/**
 * Stops the running answer, if any, and resolves once its text is saved as stopped. With
 * `generations`, which only a world change or the window's close passes, every running image
 * generation stops too.
 */
export const assistantStop = (options?: { generations: boolean }) =>
  invokeCommand<void>("assistant_stop", options);

/**
 * The links of an answer's text, each with the page it resolves to as on a page at the world's top
 * level, or `not_ready` while the index is being built. Rejects with `ai_off` and `no_world`.
 */
export const assistantLinks = (text: string) =>
  invokeCommand<EditorLinks>("assistant_links", { text });

/**
 * The open world's conversations, the latest message's newest first, with the notice when they
 * were set aside or are not being saved. Rejects with `ai_off` and `no_world`.
 */
export const assistantConversations = () => invokeCommand<Conversations>("assistant_conversations");

/** One of the open world's conversations with its messages; `not_found` when it is gone. */
export const assistantConversation = (id: number) =>
  invokeCommand<Conversation>("assistant_conversation", { id });

/**
 * Deletes one of the open world's conversations for good, once an answer running in it has
 * stopped and been saved.
 */
export const assistantDelete = (id: number) => invokeCommand<void>("assistant_delete", { id });

/**
 * The proposals of a conversation's answers, in order, each pending one checked against its page
 * as it is now, with each answer's notes and accepted sets. Rejects with `ai_off`, `no_world`,
 * `not_found` and `io`.
 */
export const assistantReview = (conversation: number) =>
  invokeCommand<AnswerReview[]>("assistant_review", { conversation });

/**
 * Writes the chosen pending proposals of an answer as one change, each with the page version its
 * card showed (none for a new page). Rejects with `conflict`, writing nothing, when none is chosen
 * or one is not pending, no longer applies or its page's version differs; a write that fails
 * partway resolves with what was written and the failure.
 */
export const assistantAccept = (answer: number, proposals: ProposalVersion[]) =>
  invokeCommand<Accepted>("assistant_accept", { answer, proposals });

/** Rejects a pending proposal for good. Rejects with `conflict` when it is not pending. */
export const assistantReject = (proposal: number) =>
  invokeCommand<void>("assistant_reject", { proposal });

/**
 * Undoes an accepted set's change as a whole, deleting the pages it created. Rejects with
 * `conflict`, naming the page, when a page changed since, and then writes nothing.
 */
export const assistantUndo = (set: number) => invokeCommand<Undone>("assistant_undo", { set });

/**
 * A conversation's images by answer, with each answer's notes about image requests, and its
 * regeneration messages. Rejects with `ai_off`, `no_world` and `not_found`.
 */
export const assistantImages = (conversation: number) =>
  invokeCommand<ConversationImages>("assistant_images", { conversation });

/**
 * Starts generating an image that is not generated, and resolves once it has started. Rejects
 * with `not_found` without a saved image provider, and `conflict` unless it is not generated.
 */
export const assistantImageGenerate = (image: number) =>
  invokeCommand<void>("assistant_image_generate", { image });

/** Stops generating an image; nothing happens when it is not being generated. */
export const assistantImageCancel = (image: number) =>
  invokeCommand<void>("assistant_image_cancel", { image });

/** Rejects a pending image for good. Rejects with `conflict` unless it is pending. */
export const assistantImageReject = (image: number) =>
  invokeCommand<void>("assistant_image_reject", { image });

/**
 * Writes a pending image to the world's `images` folder as one change, and resolves with its path
 * and whether it can be undone. Rejects with `conflict`, writing nothing, unless it is pending, and
 * with the write's error, such as `invalid_path` when `images` is not a folder.
 */
export const assistantImageApprove = (image: number) =>
  invokeCommand<ImageApproved>("assistant_image_approve", { image });

/**
 * Undoes an image's approval. Rejects with `not_found` when history no longer holds it, and with
 * `conflict`, naming the image and writing nothing, when its file changed or is gone.
 */
export const assistantImageUndo = (image: number) =>
  invokeCommand<void>("assistant_image_undo", { image });
