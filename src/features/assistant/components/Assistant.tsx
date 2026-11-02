import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import type {
  AnswerEnd,
  AnswerEvent,
  ContextPage,
  ConversationSummary,
  EditorLink,
  SavedMessage,
  StoreNotice,
} from "@/types/api";
import {
  type AnswerFailure,
  type AnswerState,
  AssistantPane,
  type ChatMessage,
} from "@/ui/AssistantPane";
import type { LinkAnchor } from "@/ui/editor-links";
import {
  assistantConversation,
  assistantConversations,
  assistantDelete,
  assistantLinks,
  assistantSend,
  assistantStop,
} from "../api/commands";

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
  /** The conversation to show on mount, the one shown last in this world, or null for a new one. */
  conversation: number | null;
  /** Called with the conversation shown, or null for a new one, whenever it changes. */
  onConversationChange: (conversation: number | null) => void;
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

/** The conversations list while it shows: its rows, null while they load, and its error. */
type ListView = { items: ConversationSummary[] | null; error: string | null };

/**
 * The assistant's conversations in this world: it shows the one shown last, sends a message, or
 * the last one again, with the active page's path, shows the answer as it arrives, and stops it
 * on Stop; it lists the world's conversations, opens and deletes them, and starts new ones. The
 * core keeps the conversations; only the new message and the active page's path go to it.
 */
export function Assistant({
  ports,
  conversation: lastShown,
  onConversationChange,
  model,
  host,
  onOpenSettings,
}: AssistantProps) {
  const [conversation, setConversation] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [loading, setLoading] = useState(lastShown !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<StoreNotice | null>(null);
  const [list, setList] = useState<ListView | null>(null);
  const nextId = useRef(0);
  /**
   * Counts the conversations shown: what a request or a load started for an earlier one is
   * ignored once another shows.
   */
  const shownCount = useRef(0);
  /** For each answer, the index revision and text its links were last asked for. */
  const linksAsked = useRef(new Map<number, string>());
  const { indexRevision } = ports;

  const last = messages.at(-1);
  const running = last?.role === "answer" && last.state === "streaming";

  function updateAnswer(id: number, change: (answer: AnswerMessage) => AnswerMessage) {
    setMessages((current) => withAnswer(current, id, change));
  }

  function show(id: number | null) {
    setConversation(id);
    onConversationChange(id);
  }

  /** Reads how the world's conversations are kept again; a failure leaves the notice shown. */
  function readNotice() {
    assistantConversations().then(
      (read) => setNotice(read.notice),
      () => {},
    );
  }

  // The conversation shown last, and how the world's conversations are kept, once on mount.
  const mounted = useEffectEvent(() => {
    readNotice();
    if (lastShown !== null) void load(lastShown);
  });
  useEffect(() => mounted(), []);

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

  /** A saved message as the conversation holds it. */
  function fromSaved(saved: SavedMessage): Message {
    const id = nextId.current++;
    if (saved.role === "user") return { id, role: "user", text: saved.text };
    const { pages, leftOut, indexing } = saved;
    return {
      id,
      role: "answer",
      text: saved.text,
      state: saved.state,
      context: { pages, leftOut, indexing },
      failure: null,
      linked: null,
    };
  }

  /** Clears the conversation shown, so that nothing still arriving for it is shown. */
  function clear() {
    shownCount.current++;
    setMessages([]);
    setRefusal(null);
    setLoadError(null);
    setLoading(false);
  }

  /**
   * Shows the conversation `id`, or an empty one when it is gone or cannot be read; one that cannot
   * be read stays the one the world remembers.
   */
  async function load(id: number) {
    clear();
    const count = shownCount.current;
    setLoading(true);
    setConversation(null);
    try {
      const loaded = await assistantConversation(id);
      if (shownCount.current !== count) return;
      setMessages(loaded.messages.map(fromSaved));
      show(id);
    } catch (error) {
      if (shownCount.current !== count) return;
      const { kind, message } = error as IpcError;
      if (kind === "not_found") show(null);
      else setLoadError(message);
    } finally {
      if (shownCount.current === count) setLoading(false);
    }
  }

  /** Stops the running answer, if any, and resolves once the core has saved it. */
  async function stopRunning() {
    // A refusal, such as with AI just switched off, leaves nothing to stop.
    if (running) await assistantStop().catch(() => {});
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
    const count = shownCount.current;
    setRefusal(null);
    setAnnouncement("");
    await ports.flushActive();
    if (shownCount.current !== count) return;
    // Text that arrives after the answer has ended is dropped: the end carries the final text.
    const onEvent = (event: AnswerEvent) => {
      if (shownCount.current !== count) return;
      if (event.kind === "context") {
        const context = {
          pages: event.pages,
          leftOut: event.leftOut,
          indexing: event.indexing,
        };
        // A new conversation is known from here on, so it can be found in the list.
        show(event.conversation);
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
      if (shownCount.current !== count) return;
      refused((error as IpcError).message);
      readNotice();
      return;
    }
    // A failed save in the core moves the conversations to memory, which the notice says.
    readNotice();
    if (shownCount.current !== count) return;
    show(end.conversation);
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

  /** Answers the last message again, in place of its failed answer, or where none arrived. */
  function retry() {
    if (!last) return;
    const replaced = last.role === "answer" ? last : null;
    const answer = newAnswer();
    setMessages((current) => [...(replaced ? current.slice(0, -1) : current), answer]);
    void request(answer, { text: "", retry: true }, (message) => {
      setMessages((current) =>
        replaced
          ? current.map((shown) => (shown.id === answer.id ? replaced : shown))
          : current.filter((shown) => shown.id !== answer.id),
      );
      setRefusal(`The message could not be sent again: ${message}`);
    });
  }

  async function startNew() {
    setList(null);
    if (conversation === null && messages.length === 0 && !loading) return;
    await stopRunning();
    clear();
    show(null);
  }

  async function readList() {
    try {
      const read = await assistantConversations();
      setNotice(read.notice);
      setList((shown) => shown && { ...shown, items: read.items });
    } catch (error) {
      const failed = `The conversations could not be read: ${(error as IpcError).message}`;
      setList((shown) => shown && { items: [], error: failed });
    }
  }

  function showList() {
    setList({ items: null, error: null });
    void readList();
  }

  async function open(id: number) {
    await stopRunning();
    setList(null);
    await load(id);
  }

  async function remove(id: number) {
    try {
      await assistantDelete(id);
    } catch (error) {
      const failed = `The conversation could not be deleted: ${(error as IpcError).message}`;
      setList((shown) => shown && { ...shown, error: failed });
      return;
    }
    if (id === conversation) {
      clear();
      show(null);
    }
    await readList();
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
      onNewConversation={() => void startNew()}
      onShowConversations={showList}
      storeNotice={notice}
      conversations={
        list
          ? {
              ...list,
              onOpen: (id) => void open(id),
              onDelete: remove,
              onBack: () => setList(null),
            }
          : undefined
      }
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
        loading,
        loadError,
      }}
    />
  );
}
