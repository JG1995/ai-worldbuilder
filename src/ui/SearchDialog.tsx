import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Mark, PageMatch } from "@/types/api";
import { Icon } from "./Icon";

/**
 * What the dialog lists for `query`, the query an answer is for: the pages that match it, with the
 * Create row when `create` is set, or why pages cannot be searched.
 */
export type SearchResults =
  | { state: "ready" | "building"; query: string; pages: PageMatch[]; create: boolean }
  | { state: "failed"; query: string; message: string };

/** A picked row: a page, or the Create row. */
export type SearchPick = { kind: "page"; path: string } | { kind: "create" };

type SearchDialogProps = {
  query: string;
  onQueryChange: (query: string) => void;
  /** Null while there is nothing to list: the query is empty, or its first answer is on its way. */
  results: SearchResults | null;
  /** Why the page could not be created, under the input. */
  createError?: string;
  /** In the current tab, or in a new tab for Ctrl/Cmd+Enter, Ctrl/Cmd+click or a middle click. */
  onPick: (pick: SearchPick, options: { newTab: boolean }) => void;
  /** Escape or a press outside the dialog; focus has gone back to where it was when it opened. */
  onClose: () => void;
};

type Row = { key: string; pick: SearchPick; content: ReactNode };

const createKey = "create";

/** `text` with the characters in `mark`, shifted by `offset`, underlined. */
function marked(text: string, mark: Mark | null, offset = 0) {
  const from = Math.max((mark?.from ?? 0) - offset, 0);
  const to = Math.min((mark?.to ?? 0) - offset, text.length);
  if (!mark || from >= to) return text;
  return (
    <>
      {text.slice(0, from)}
      <span className="underline decoration-1 underline-offset-2">{text.slice(from, to)}</span>
      {text.slice(to)}
    </>
  );
}

function PageRow({ page }: { page: PageMatch }) {
  const slash = page.path.lastIndexOf("/");
  const folder = slash === -1 ? "" : page.path.slice(0, slash);
  // A path match's mark runs through the path without `.md`: the folder, a `/` and the name.
  const nameStart = page.field === "path" && folder ? folder.length + 1 : 0;
  const nameMark = page.field === "alias" ? null : page.mark;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="ui-strong min-w-0 shrink-0 truncate text-text">
        {marked(page.name, nameMark, nameStart)}
      </span>
      {folder && (
        <span className="ui-small min-w-0 truncate text-text-muted">
          {marked(folder, page.field === "path" ? page.mark : null)}
        </span>
      )}
      {page.field === "alias" && page.alias !== null && (
        <span className="ui-small min-w-0 truncate text-text-muted">
          alias: {marked(page.alias, page.mark)}
        </span>
      )}
    </span>
  );
}

function rowsOf(results: SearchResults | null): Row[] {
  if (!results || results.state === "failed") return [];
  const rows: Row[] = results.pages.map((page) => ({
    key: page.path,
    pick: { kind: "page", path: page.path },
    content: <PageRow page={page} />,
  }));
  if (results.create) {
    rows.push({
      key: createKey,
      pick: { kind: "create" },
      content: (
        <span className="ui flex min-w-0 items-center gap-2 text-text">
          <span className="flex shrink-0 text-text-muted">
            <Icon name="note_add" />
          </span>
          <span className="truncate">Create page "{results.query}"</span>
        </span>
      ),
    });
  }
  return rows;
}

function announcement(results: SearchResults | null, rows: Row[]) {
  if (!results) return "";
  if (results.state === "failed") return `Pages cannot be searched: ${results.message}`;
  const pages = results.pages.length;
  const parts = [results.state === "building" ? "Indexing world…" : ""];
  if (pages === 0) parts.push(`Nothing matches "${results.query}".`);
  else parts.push(pages === 1 ? "1 page matches." : `${pages} pages match.`);
  if (rows.some((row) => row.key === createKey)) parts.push(`Create page "${results.query}".`);
  return parts.filter(Boolean).join(" ");
}

/**
 * Consumes the click that ends a press on the backdrop, so the press that closes the dialog
 * activates nothing that the backdrop covered, as with menus.
 */
function swallowNextClick() {
  const done = new AbortController();
  const options = { capture: true, signal: done.signal };
  const stopSwallowing = () => setTimeout(() => done.abort());
  window.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      done.abort();
    },
    options,
  );
  window.addEventListener("pointerup", stopSwallowing, options);
  window.addEventListener("pointercancel", stopSwallowing, options);
}

/**
 * The quick open dialog: an input that searches the world's pages, above the rows that answer it,
 * in a portal on the dialog layer. Focus stays in the input, a combobox whose active descendant is
 * the selected row. Up and Down move the selection, Enter and a click pick in the current tab, and
 * with Ctrl/Cmd or a middle click in a new tab; Escape and a press outside close and return focus
 * to where it was. A pick leaves focus to whatever it opens.
 */
export function SearchDialog({
  query,
  onQueryChange,
  results,
  createError,
  onPick,
  onClose,
}: SearchDialogProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const rows = rowsOf(results);
  // The selected row for the answer shown: the first row of a new query's answer, and the same row
  // in a new answer to the same query while it is still listed.
  const [selection, setSelection] = useState({ results, key: rows[0]?.key });
  let selectedKey = selection.key;
  if (selection.results !== results) {
    const sameQuery = selection.results?.query === results?.query;
    const kept = sameQuery && rows.some((row) => row.key === selection.key);
    selectedKey = kept ? selection.key : rows[0]?.key;
    setSelection({ results, key: selectedKey });
  }
  const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
  const optionId = (index: number) => `${id}-option-${index}`;
  const listboxId = `${id}-listbox`;
  const errorId = `${id}-error`;

  useEffect(() => {
    // Once: React runs this again in development, when focus is already in the input.
    opener.current ??= document.activeElement;
    input.current?.focus();
  }, []);

  function close() {
    const previous = opener.current;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    onClose();
  }

  function select(index: number) {
    const row = rows[index];
    if (row) setSelection({ results, key: row.key });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const handled = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"];
    if (!handled.includes(event.key)) return;
    event.preventDefault();
    // The window's shortcuts never see the keys the dialog handles.
    event.stopPropagation();
    if (event.key === "ArrowDown") select(Math.min(selectedIndex + 1, rows.length - 1));
    else if (event.key === "ArrowUp") select(Math.max(selectedIndex - 1, 0));
    else if (event.key === "Escape") close();
    else if (event.key === "Enter" && rows[selectedIndex]) {
      onPick(rows[selectedIndex].pick, { newTab: event.ctrlKey || event.metaKey });
    }
  }

  function onRowClick(event: MouseEvent, row: Row) {
    onPick(row.pick, { newTab: event.ctrlKey || event.metaKey });
  }

  const status =
    results?.state === "failed" ? (
      <p className="ui flex items-start gap-1 text-text">
        <span className="flex pt-0.5 text-error">
          <Icon name="error" />
        </span>
        <span className="min-w-0">Pages cannot be searched: {results.message}</span>
      </p>
    ) : (
      <>
        {results?.state === "building" && (
          <p className="ui flex items-center gap-1 text-info">
            <Icon name="info" />
            Indexing world…
          </p>
        )}
        {results && results.pages.length === 0 && (
          <p className="ui text-text-muted">Nothing matches "{results.query}".</p>
        )}
      </>
    );

  return createPortal(
    // A press on the backdrop closes the dialog and does nothing else.
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the dialog for the keyboard.
    <div
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (event.button === 0) swallowNextClick();
        close();
      }}
      className="fixed inset-0 z-(--z-dialog) flex flex-col items-center bg-backdrop p-4 pt-[15vh] transition-opacity duration-(--duration-fade) starting:opacity-0"
    >
      {/* A press anywhere in the dialog but the input leaves focus in the input. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search pages"
        onMouseDown={(event) => event.target !== input.current && event.preventDefault()}
        className="flex max-h-full min-h-0 w-[640px] max-w-full flex-col rounded-md border border-divider bg-raised text-text shadow-(--level-2-shadow)"
      >
        <div className="flex flex-col gap-1 p-3">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search pages"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={selectedIndex === -1 ? undefined : optionId(selectedIndex)}
            aria-invalid={createError ? true : undefined}
            aria-describedby={createError ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search pages by name or alias"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            className={`body h-10 min-w-0 rounded-sm border bg-input px-3 text-text transition-colors placeholder:text-text-muted ${createError ? "border-error" : "border-outline focus:border-accent"}`}
          />
          {createError && (
            <p id={errorId} className="ui-small flex items-center gap-1 text-error">
              <Icon name="error" />
              {createError}
            </p>
          )}
        </div>
        {results && (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto border-divider border-t py-2">
            <div className="flex flex-col gap-2 px-3 empty:hidden">{status}</div>
            <div
              id={listboxId}
              role="listbox"
              aria-label="Pages"
              className="flex flex-col empty:hidden"
            >
              {rows.map((row, index) => (
                // The input keeps focus and handles the keyboard for every row.
                // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input handles keys.
                <div
                  key={row.key}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selectedIndex}
                  onClick={(event) => onRowClick(event, row)}
                  onAuxClick={(event) => {
                    if (event.button === 1) onPick(row.pick, { newTab: true });
                  }}
                  className={`relative flex min-h-control-compact cursor-default items-center px-3 py-1 transition-colors ${
                    index === selectedIndex
                      ? "bg-selected before:absolute before:inset-y-0 before:left-0 before:border-accent before:border-l-2"
                      : "hover:bg-hover"
                  }`}
                >
                  {row.content}
                </div>
              ))}
            </div>
          </div>
        )}
        <p role="status" className="sr-only">
          {announcement(results, rows)}
        </p>
      </div>
    </div>,
    document.body,
  );
}
