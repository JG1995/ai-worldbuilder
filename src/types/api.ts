// The shapes the Rust core sends and takes. ts-rs generates them from the Rust types into
// ./generated/ when the Rust tests run (`pnpm bindings`); never edit those files by hand.

export type { Accepted } from "./generated/Accepted";
export type { AcceptedSet } from "./generated/AcceptedSet";
export type { AcceptFailure } from "./generated/AcceptFailure";
export type { AnswerEnd } from "./generated/AnswerEnd";
export type { AnswerEvent } from "./generated/AnswerEvent";
export type { AnswerImages } from "./generated/AnswerImages";
export type { AnswerReview } from "./generated/AnswerReview";
export type { AnswerState } from "./generated/AnswerState";
export type { Backlink } from "./generated/Backlink";
export type { Backlinks } from "./generated/Backlinks";
export type { Comparison } from "./generated/Comparison";
export type { ContextPage } from "./generated/ContextPage";
export type { Conversation } from "./generated/Conversation";
export type { ConversationImages } from "./generated/ConversationImages";
export type { ConversationSummary } from "./generated/ConversationSummary";
export type { Conversations } from "./generated/Conversations";
export type { DiffLine } from "./generated/DiffLine";
export type { EditorLink } from "./generated/EditorLink";
export type { EditorLinks } from "./generated/EditorLinks";
export type { EntryKind } from "./generated/EntryKind";
export type { ErrorKind } from "./generated/ErrorKind";
export type { GenerationFailure } from "./generated/GenerationFailure";
export type { HistoryVersion } from "./generated/HistoryVersion";
export type { ImageApproved } from "./generated/ImageApproved";
export type { ImageEmbed } from "./generated/ImageEmbed";
export type { ImageFailure } from "./generated/ImageFailure";
export type { ImageForm } from "./generated/ImageForm";
export type { ImageFrame } from "./generated/ImageFrame";
export type { ImageProvider } from "./generated/ImageProvider";
export type { ImageReference } from "./generated/ImageReference";
export type { ImageRequest } from "./generated/ImageRequest";
export type { ImageReview } from "./generated/ImageReview";
export type { ImageState } from "./generated/ImageState";
export type { ImageTestOutcome } from "./generated/ImageTestOutcome";
export type { KeyStorage } from "./generated/KeyStorage";
export type { LineKind } from "./generated/LineKind";
export type { LinkedPage } from "./generated/LinkedPage";
export type { LinkState } from "./generated/LinkState";
export type { LinkSuggestion } from "./generated/LinkSuggestion";
export type { LinkSuggestions } from "./generated/LinkSuggestions";
export type { Mark } from "./generated/Mark";
export type { MatchField } from "./generated/MatchField";
export type { NewEntry } from "./generated/NewEntry";
export type { NewLocation } from "./generated/NewLocation";
export type { NotGenerated } from "./generated/NotGenerated";
export type { PageMatch } from "./generated/PageMatch";
export type { PageMatches } from "./generated/PageMatches";
export type { PageText } from "./generated/PageText";
export type { PageVersion } from "./generated/PageVersion";
export type { Properties } from "./generated/Properties";
export type { Property } from "./generated/Property";
export type { PropertyValue } from "./generated/PropertyValue";
export type { ProposalCheck } from "./generated/ProposalCheck";
export type { ProposalKind } from "./generated/ProposalKind";
export type { ProposalReview } from "./generated/ProposalReview";
export type { ProposalState } from "./generated/ProposalState";
export type { ProposalVersion } from "./generated/ProposalVersion";
export type { ProviderFailure } from "./generated/ProviderFailure";
export type { ProviderField } from "./generated/ProviderField";
export type { ProviderSaved } from "./generated/ProviderSaved";
export type { RecentWorld } from "./generated/RecentWorld";
export type { Regeneration } from "./generated/Regeneration";
export type { RestoredPage } from "./generated/RestoredPage";
export type { SavedMessage } from "./generated/SavedMessage";
export type { Settings } from "./generated/Settings";
export type { StoreNotice } from "./generated/StoreNotice";
export type { TestOutcome } from "./generated/TestOutcome";
export type { TextLine } from "./generated/TextLine";
export type { TextMatch } from "./generated/TextMatch";
export type { TextMatches } from "./generated/TextMatches";
export type { TextProvider } from "./generated/TextProvider";
export type { Theme } from "./generated/Theme";
export type { TreeEntry } from "./generated/TreeEntry";
export type { Undone } from "./generated/Undone";
export type { VersionKind } from "./generated/VersionKind";
export type { Workspace } from "./generated/Workspace";
export type { WorldOpened } from "./generated/WorldOpened";
export type { WrittenPage } from "./generated/WrittenPage";

/**
 * The watcher's, the world history's and the page index's events, by the name each is sent under. Each carries the
 * session of the opening it belongs to, so events from a world that is no longer open can be told
 * apart. Kept by hand: the core's `WorldEvent` is one untagged enum, and only `WorldEvent::name` in
 * `world/watch.rs` holds the names.
 */
export type WorldEvents = {
  /** Entries were created, removed or renamed (`tree`), or the pages at `pages` changed on disk. */
  "world:changed": { session: number; tree: boolean; pages: string[] };
  /** The world's folder is gone. */
  "world:missing": { session: number };
  /** The watcher could not start or stopped working. */
  "world:watch-failed": { session: number; message: string };
  /** The world's changes are not being recorded in its history, for the reason in `message`. */
  "world:history-not-recording": { session: number; message: string };
  /** The world's changes are being recorded again. */
  "world:history-recording": { session: number };
  /** The world's history database was damaged, so it was set aside and a new one started. */
  "world:history-set-aside": { session: number };
  /** The page index was built, or what it holds changed. */
  "world:index-changed": { session: number };
  /** The page index cannot be built, because the world cannot be listed, for the reason given. */
  "world:index-failed": { session: number; message: string };
};

/**
 * The assistant's events, by the name each is sent under. Kept by hand: the core's `ImageChanged`
 * in `assistant/images.rs` is not a generated type.
 */
export type AssistantEvents = {
  /** An image of `conversation`, in the world opening `session`, changed its state. */
  "assistant:image-changed": { session: number; conversation: number };
};
