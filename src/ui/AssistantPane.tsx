import type { EditorView } from "@codemirror/view";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { EditorLink, ProviderFailure } from "@/types/api";
import { Button, IconButton } from "./Button";
import { setLinks } from "./editor-links";
import { Icon } from "./Icon";
import { createPageState, MarkdownEditor } from "./MarkdownEditor";
import { Notice } from "./Notice";
import { Tooltip } from "./Tooltip";

/** How an answer stands: still arriving, or how it ended. */
export type AnswerState = "streaming" | "complete" | "stopped" | "cut_off" | "failed";

/**
 * The pages an answer's request carried, how many earlier messages it left out, and whether the
 * world was still being indexed when the pages were chosen.
 */
export type AnswerContext = {
  /** In the order the core chose them; `gone` when the world no longer has the page. */
  pages: { path: string; partial: boolean; gone: boolean }[];
  leftOut: number;
  indexing: boolean;
};

export type AnswerFailure = {
  reason: ProviderFailure;
  detail: string | null;
  /** The provider's own message, shown as plain text. */
  providerMessage: string | null;
};

export type ChatMessage =
  | { id: number; role: "user"; text: string }
  | {
      id: number;
      role: "answer";
      /** Markdown, shown as text in a read-only editor. */
      text: string;
      state: AnswerState;
      /** Absent until the request leaves, and when none did. */
      context: AnswerContext | null;
      failure: AnswerFailure | null;
      /** The links of its text, marked once known; absent leaves the marks as they are. */
      links?: readonly EditorLink[];
    };

/** The conversation and its composer. */
export type AssistantChat = {
  messages: ChatMessage[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Sends the conversation's last message again, after its answer failed. */
  onRetry: () => void;
  onOpenPage: (path: string, options: { newTab: boolean }) => void;
  /** Follows a link in an answer: Ctrl/Cmd+click on it, or Alt/Option+Enter with the cursor in it. */
  onFollowLink: (link: EditorLink) => void;
  /** Copies an answer's Markdown text. */
  onCopy: (text: string) => void;
  /** Why the core refused the last message or retry, shown above the composer. */
  refusal: string | null;
  /** What the polite live region announces, such as an answer's end. */
  announcement: string;
};

type AssistantPaneProps = {
  /** The saved text provider's model. Without it, no provider is saved. */
  model?: string;
  /** The saved text provider's host, where the assistant sends what it reads. */
  host?: string;
  onOpenSettings: () => void;
  /** The conversation and the composer. Without it, the pane shows neither. */
  chat?: AssistantChat;
};

/** The composer grows with its text up to this many lines, then scrolls. */
export const maxComposerLines = 8;

/** How close to the end, in pixels, the message area must be to keep following new text. */
const followSlack = 16;

/**
 * The assistant pane's content: its header, with the model's name when a provider is saved; the
 * notice that asks for a provider; the conversation, or the explanation of an empty one; and the
 * composer, where Enter sends and Send becomes Stop while an answer arrives.
 */
export function AssistantPane({ model, host, onOpenSettings, chat }: AssistantPaneProps) {
  const messages = chat?.messages ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const shownMessages = useRef(messages.length);

  // While an answer arrives, the area follows its newest text unless the user scrolled up; a new
  // message follows again. The answers' editors have taken their text by now: child effects run
  // first.
  useEffect(() => {
    const area = scroller.current;
    if (!area) return;
    if (messages.length > shownMessages.current) following.current = true;
    shownMessages.current = messages.length;
    if (following.current) area.scrollTop = area.scrollHeight;
  }, [messages]);

  function rememberPosition() {
    const area = scroller.current;
    if (area) {
      following.current = area.scrollHeight - area.scrollTop - area.clientHeight <= followSlack;
    }
  }

  const last = messages.at(-1);
  const running = last?.role === "answer" && last.state === "streaming";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-tab-strip shrink-0 items-center gap-2 border-divider border-b bg-window px-3">
        <h2 className="label-caps shrink-0 text-text">Assistant</h2>
        {model && <span className="ui-small min-w-0 truncate text-text-muted">{model}</span>}
      </header>
      <div
        ref={scroller}
        onScroll={rememberPosition}
        className="min-h-0 flex-1 overflow-y-auto bg-page"
      >
        {!model && (
          <Notice
            status="info"
            actions={
              <Button variant="secondary" onClick={onOpenSettings}>
                Settings
              </Button>
            }
          >
            Add a provider in Settings to use the assistant.
          </Notice>
        )}
        {model && messages.length === 0 && (
          <p className="ui p-4 text-text-muted">
            For each message, the assistant reads the pages of this world that matter to it and
            sends them, with your message, to {host}. It answers here and changes no pages.
          </p>
        )}
        {chat && messages.length > 0 && (
          <ol aria-label="Conversation" className="flex flex-col gap-4 p-4">
            {messages.map((message) =>
              message.role === "user" ? (
                <li
                  key={message.id}
                  // The border shows the block in light mode, where raised is as white as page.
                  className="assistant ml-8 self-end whitespace-pre-wrap break-words rounded-md border border-divider bg-raised px-3 py-2 text-text"
                >
                  {message.text}
                </li>
              ) : (
                <Answer
                  key={message.id}
                  answer={message}
                  host={host}
                  canRetry={message === last && !running}
                  chat={chat}
                />
              ),
            )}
          </ol>
        )}
      </div>
      {chat && (
        <>
          {chat.refusal && <Notice status="error">{chat.refusal}</Notice>}
          {/* Without a provider, nothing can be sent: the notice above asks for one. */}
          {model && <Composer chat={chat} running={running} />}
          <div aria-live="polite" className="sr-only">
            {chat.announcement}
          </div>
        </>
      )}
    </div>
  );
}

function Answer({
  answer,
  host,
  canRetry,
  chat,
}: {
  answer: Extract<ChatMessage, { role: "answer" }>;
  host: string | undefined;
  canRetry: boolean;
  chat: AssistantChat;
}) {
  const { text, state, context, failure, links } = answer;
  return (
    <li className="flex flex-col gap-2">
      {context && <ContextDisclosure context={context} onOpenPage={chat.onOpenPage} />}
      {/* Mounted while still empty, so the arriving text can grow into it. */}
      <div className={`assistant text-text ${text === "" ? "hidden" : ""}`}>
        <AnswerText text={text} links={links} onFollow={chat.onFollowLink} />
      </div>
      {state !== "streaming" && text !== "" && (
        <div className="flex">
          <IconButton icon="content_copy" label="Copy" onClick={() => chat.onCopy(text)} />
        </div>
      )}
      {state === "streaming" && text === "" && (
        <p className="ui-small text-text-muted">Waiting for the answer…</p>
      )}
      {state === "stopped" && <p className="ui-small text-text-muted">Stopped.</p>}
      {state === "cut_off" && (
        <p className="ui-small text-text-muted">Cut off: the answer was too long.</p>
      )}
      {failure && (
        <Notice
          status={failure.reason === "rate_limited" ? "warning" : "error"}
          actions={
            canRetry && (
              <Button variant="secondary" onClick={chat.onRetry}>
                Retry
              </Button>
            )
          }
        >
          <span className="block">{failureText(failure, host)}</span>
          {failure.providerMessage && (
            <span className="block break-words">
              The provider's message: {failure.providerMessage}
            </span>
          )}
        </Notice>
      )}
    </li>
  );
}

/**
 * An answer's Markdown in a read-only editor, never as HTML. New text that continues the shown
 * text is added to its end, so a streaming answer grows without rebuilding the editor. Its links
 * are marked once they are known, and following one goes to `onFollow`.
 */
function AnswerText({
  text,
  links,
  onFollow,
}: {
  text: string;
  links: readonly EditorLink[] | undefined;
  onFollow: (link: EditorLink) => void;
}) {
  const view = useRef<EditorView>(null);
  const [state] = useState(() => createPageState(text, "Answer"));

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const shown = editor.state.doc.toString();
    if (shown === text) return;
    const from = text.startsWith(shown) ? shown.length : 0;
    editor.dispatch({
      changes: { from, to: editor.state.doc.length, insert: text.slice(from) },
    });
  }, [text]);

  // After the text's effect, so the links fall on the text they belong to.
  useEffect(() => {
    if (links) view.current?.dispatch({ effects: setLinks(links) });
  }, [links]);

  return <MarkdownEditor state={state} readOnly viewRef={view} onFollow={onFollow} />;
}

/** "Read N pages", which expands to the pages an answer's request carried. */
function ContextDisclosure({
  context,
  onOpenPage,
}: {
  context: AnswerContext;
  onOpenPage: AssistantChat["onOpenPage"];
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { pages, leftOut, indexing } = context;

  return (
    <div className="ui-small text-text-muted">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded-sm transition-colors hover:text-text"
      >
        <Icon name={open ? "expand_more" : "chevron_right"} />
        Read {pages.length} {pages.length === 1 ? "page" : "pages"}
      </button>
      <div id={listId} hidden={!open} className="mt-1 flex flex-col gap-1 pl-5">
        {pages.length === 0 ? (
          <p>No pages were read.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {pages.map((page) => {
              const name = pageName(page.path);
              const folder = page.path.includes("/")
                ? page.path.slice(0, page.path.lastIndexOf("/"))
                : null;
              return (
                <li key={page.path} className="flex flex-wrap items-baseline gap-x-2">
                  {page.gone ? (
                    <span className="text-text">{name}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={(event) =>
                        onOpenPage(page.path, { newTab: event.ctrlKey || event.metaKey })
                      }
                      className="rounded-sm text-accent underline transition-colors hover:text-accent-hover"
                    >
                      {name}
                    </button>
                  )}
                  {folder && <span>{folder}</span>}
                  {page.partial && <span>(partly read)</span>}
                </li>
              );
            })}
          </ul>
        )}
        {leftOut > 0 && (
          <p>
            {leftOut} earlier {leftOut === 1 ? "message was" : "messages were"} left out.
          </p>
        )}
        {indexing && <p>The world was still being indexed, so some pages may be missing.</p>}
      </div>
    </div>
  );
}

/** The message input and the Send button, which becomes Stop while an answer arrives. */
function Composer({ chat, running }: { chat: AssistantChat; running: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const canSend = !running && chat.draft.trim() !== "";

  // One line, then a line more while the text overflows, up to the limit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft's length decides the lines.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.rows = 1;
    while (field.rows < maxComposerLines && field.scrollHeight > field.clientHeight) {
      field.rows += 1;
    }
  }, [chat.draft]);

  return (
    <div className="flex shrink-0 items-end gap-2 border-divider border-t bg-window p-3">
      <textarea
        ref={input}
        aria-label="Message"
        placeholder="Ask about this world"
        data-initial-focus
        value={chat.draft}
        onChange={(event) => chat.onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (canSend) chat.onSend();
        }}
        className="ui min-w-0 flex-1 resize-none rounded-sm border border-outline bg-input px-2 py-1.5 text-text transition-colors placeholder:text-text-muted focus:border-accent"
      />
      <Tooltip text={running ? "Stop" : "Send"} shortcut={running ? undefined : "Enter"}>
        {(describedBy) => (
          <Button
            variant="secondary"
            aria-label={running ? "Stop" : "Send"}
            aria-describedby={describedBy}
            disabled={!running && !canSend}
            onClick={running ? chat.onStop : chat.onSend}
          >
            <Icon name={running ? "stop" : "send"} />
          </Button>
        )}
      </Tooltip>
    </div>
  );
}

const pageName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** `text`, then `reason` when there is one, as one sentence. */
function withReason(text: string, reason: string | null) {
  if (!reason) return `${text}.`;
  return /[.!?]$/.test(reason) ? `${text}: ${reason}` : `${text}: ${reason}.`;
}

/** What a failed answer means, and what to check. */
function failureText({ reason, detail }: AnswerFailure, host = "The provider") {
  switch (reason) {
    case "unreachable":
      return `${withReason(`${host} could not be reached`, detail)} Check the base URL and your network connection.`;
    case "insecure":
      return `${withReason(`The secure connection to ${host} failed`, detail)} Check the base URL, and that the server's certificate is valid.`;
    case "timeout":
      return `${host} sent nothing for 120 seconds. Try again later, or check the base URL.`;
    case "key_refused":
      return "The provider refused the API key. Check that the key is valid for this provider.";
    case "key_needed":
      return "The provider needs an API key. Add one in Settings.";
    case "not_found":
      return "The base URL or the model was not found. Check them in Settings.";
    case "rate_limited":
      return "The provider is limiting requests. Try again later.";
    case "refused":
      return "The provider refused the request.";
    case "provider_error":
      return "The provider reported a problem on its side. Try again later.";
    case "redirected":
      return `The provider redirected the request to ${detail ?? "another address"}. Check the base URL.`;
    case "invalid_reply":
      return "The answer is not an OpenAI-compatible chat answer, or it has no text. Check the base URL and the model.";
    case "interrupted":
      return "The connection ended before the answer was complete.";
    case "key_unreadable":
      return `${withReason("The key cannot be read from its storage", detail)} Nothing was sent.`;
  }
}
