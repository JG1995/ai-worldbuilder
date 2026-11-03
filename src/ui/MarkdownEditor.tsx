import { closeCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Compartment,
  type EditorSelection,
  EditorState,
  type Extension,
  Facet,
  RangeSetBuilder,
  StateField,
  Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";
import type { EditorLink } from "@/types/api";
import { editorLinks, frontmatterEnd, linkAt } from "./editor-links";
import { linkSuggestions, type Suggest, suggestFacet } from "./link-suggestions";
import { livePreview, previewView } from "./live-preview";
import { pageSyntax } from "./markdown-syntax";
import { propertiesBlock } from "./properties-block";
import { gridPosition, linkStart, tableGrid } from "./table-grid";

// The class names below are styled in the editor section of src/ui/theme.css.
const monoClass = "cm-mono";

/** Code spans and code block text take the `mono` type role. */
const codeHighlight = HighlightStyle.define([{ tag: tags.monospace, class: monoClass }]);

const monoLine = Decoration.line({ class: monoClass });

/** A block of lines from a first line of `---` to the next `---` line, as Obsidian reads it. */
function frontmatterDecorations(doc: Text): DecorationSet {
  const end = frontmatterEnd(doc);
  if (end === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (let number = 1; number <= end; number++) {
    const line = doc.line(number);
    builder.add(line.from, line.from, monoLine);
  }
  return builder.finish();
}

const frontmatter = StateField.define<DecorationSet>({
  create: (state) => frontmatterDecorations(state.doc),
  update: (decorations, transaction) =>
    transaction.docChanged ? frontmatterDecorations(transaction.state.doc) : decorations,
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The style nonce Tauri gives the empty style element in index.html on every page load. CodeMirror
 * mounts its base theme as a style element, which the content security policy blocks without it. The property, not the attribute: browsers hide the attribute's value. Outside Tauri there is
 * no nonce, and CodeMirror ignores the empty string.
 */
function styleNonce() {
  return document.head.querySelector<HTMLStyleElement>("style[nonce]")?.nonce ?? "";
}

/** The function the link suggestion list asks, which `MarkdownEditor` sets from its `suggest`. */
const suggestion = new Compartment();

/**
 * Whether the editor is editable and read-only, and which view the live preview shows, together:
 * the reading view is never editable and always read-only, whatever order they were set in. It
 * comes first among a state's extensions, so no other provider of those facets wins over it.
 */
const mode = new Compartment();
const modes = new Map<string, Extension>();

/**
 * In the reading view the text takes focus, as `EditorView.focus` gives it, only to pass it to the
 * tab stop around the editor, the page's scrolling region, so the keys that scroll it work and Tab
 * goes on to the links. Without one the text keeps it; it is never a tab stop itself.
 */
const focusPage = [
  EditorView.contentAttributes.of({ tabindex: "-1" }),
  EditorView.domEventHandlers({
    focus: (event, view) => {
      if (event.target !== view.contentDOM) return;
      view.dom.parentElement
        ?.closest<HTMLElement>('[tabindex="0"]')
        ?.focus({ preventScroll: true });
    },
  }),
];

function modeOf(reading: boolean, readOnly: boolean) {
  const key = `${reading} ${readOnly}`;
  let extension = modes.get(key);
  if (!extension) {
    extension = [
      EditorView.editable.of(!reading),
      EditorState.readOnly.of(reading || readOnly),
      previewView.of(reading ? "reading" : "editing"),
      reading ? [EditorView.editorAttributes.of({ class: "page-reading" }), focusPage] : [],
    ];
    modes.set(key, extension);
  }
  return extension;
}

function setMode(editor: EditorView, extension: Extension) {
  if (mode.get(editor.state) !== extension) {
    editor.dispatch({ effects: mode.reconfigure(extension) });
  }
}

function isReading(state: EditorState) {
  return state.facet(previewView) === "reading";
}

/**
 * The editing view's selection while the reading view shows, mapped through the changes made
 * meanwhile, so that a selection made in the reading view's text, which CodeMirror reads into the
 * state, leaves it alone; null in the editing view.
 */
const editingSelection = StateField.define<EditorSelection | null>({
  create: () => null,
  update: (saved, transaction) => {
    if (!isReading(transaction.state)) return null;
    if (!isReading(transaction.startState)) {
      return transaction.startState.selection.map(transaction.changes);
    }
    return saved?.map(transaction.changes) ?? null;
  },
});

/** The editing view takes back its selection as the reading view ends. */
const restoreEditingSelection = EditorState.transactionFilter.of((transaction) => {
  const saved = transaction.startState.field(editingSelection, false);
  if (!saved || isReading(transaction.state)) return transaction;
  return [transaction, { selection: saved.map(transaction.changes), sequential: true }];
});

/** The selection the editing view has, or will have again once the reading view ends. */
function selectionOf(state: EditorState) {
  return state.field(editingSelection, false) ?? state.selection;
}

/** Whether a state shows the live preview, so that a reload of it does too. */
const previewOn = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

type PageStateOptions = {
  /** Shows the live preview, which hides Markdown syntax away from the cursor; off by default. */
  preview?: boolean;
};

/**
 * The editor state for a page's text, with the cursor at `cursor` (the start by default); `label`
 * names the editor for assistive technology.
 */
export function createPageState(
  text: string,
  label: string,
  cursor = 0,
  { preview = false }: PageStateOptions = {},
) {
  return EditorState.create({
    doc: text,
    selection: { anchor: cursor },
    extensions: [
      mode.of(modeOf(false, false)),
      editingSelection,
      restoreEditingSelection,
      markdown({ extensions: pageSyntax }),
      previewOn.of(preview),
      preview ? [livePreview, tableGrid, propertiesBlock] : [],
      syntaxHighlighting(codeHighlight),
      frontmatter,
      editorLinks,
      linkSuggestions,
      suggestion.of([]),
      EditorView.lineWrapping,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editorAttributes.of({ class: "page-editor" }),
      EditorView.contentAttributes.of({ "aria-label": label }),
      // Every editor carries it, because CodeMirror creates its element for the first one to mount.
      EditorView.cspNonce.of(styleNonce()),
    ],
  });
}

/**
 * A fresh state for the page's new `text`, with no undo history, the live preview if `previous`
 * showed it, and the editing view's cursor at the line and column it had in `previous`, or at the
 * nearest position the new text has.
 */
export function reloadedState(previous: EditorState, text: string, label: string) {
  const head = selectionOf(previous).main.head;
  const { number, from } = previous.doc.lineAt(head);
  const doc = Text.of(text.split("\n"));
  const line = doc.line(Math.min(number, doc.lines));
  return createPageState(text, label, Math.min(line.from + head - from, line.to), {
    preview: previous.facet(previewOn),
  });
}

/** What each mounted editor reports a state that `replaceState` put in it to. */
const replaceListeners = new WeakMap<EditorView, (state: EditorState) => void>();

/**
 * Puts `state` in the running editor in place of its own, keeping its view, whether it is
 * read-only and the function its link suggestions ask, and reports it through the editor's
 * `onReplace`.
 */
export function replaceState(editor: EditorView, state: EditorState) {
  const shown = mode.get(editor.state);
  const suggest = suggestion.get(editor.state);
  editor.setState(state);
  if (shown) setMode(editor, shown);
  if (suggest) editor.dispatch({ effects: suggestion.reconfigure(suggest) });
  replaceListeners.get(editor)?.(editor.state);
}

/**
 * Whether a mouse down asks to follow a link: the primary button with Ctrl or Cmd alone, or in the
 * reading view with neither too.
 */
function isFollowClick(event: MouseEvent, reading: boolean) {
  const plain = !event.ctrlKey && !event.metaKey;
  return (
    event.button === 0 &&
    (event.ctrlKey !== event.metaKey || (reading && plain)) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Whether a key press asks to follow a link: Alt/Option+Enter alone, or Enter in the reading view. */
function isFollowKey(event: KeyboardEvent, reading: boolean) {
  return (
    event.key === "Enter" &&
    (event.altKey || reading) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** The focusable link element of the reading view that `target` is in, in `editor`'s text. */
function linkElement(editor: EditorView, target: EventTarget | null) {
  const element = target instanceof Element ? target.closest("[data-link]") : null;
  return element && editor.contentDOM.contains(element) ? element : null;
}

/** Replaces the whole document with `text` as one step that undo reverts on its own. */
export function replaceDocument(editor: EditorView, text: string) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    annotations: isolateHistory.of("full"),
  });
}

type MarkdownEditorProps = {
  /** From `createPageState`. The editor starts from it when it mounts. */
  state: EditorState;
  readOnly: boolean;
  /**
   * Shows the reading view: read-only, not editable, with no syntax and with focusable links. It
   * needs a state created with the live preview. Off by default.
   */
  reading?: boolean;
  /** Puts the cursor in the editor when it mounts. Later changes do nothing. */
  autoFocus?: boolean;
  /** Holds the running editor while it is mounted, for changes such as `replaceDocument`. */
  viewRef?: RefObject<EditorView | null>;
  /** Receives the editor's state after every change to its text. */
  onChange?: (state: EditorState) => void;
  /** Receives the editor's last state when it unmounts, so the page can resume where it was. */
  onUnmount?: (state: EditorState) => void;
  /** Receives the state that `replaceState` put in the editor, as after a reload. */
  onReplace?: (state: EditorState) => void;
  /**
   * Receives a link to follow: Ctrl/Cmd+click on it, or Alt/Option+Enter with the cursor in it. In
   * the reading view, a click or Enter on a resolved link, and only a resolved one. Each then does
   * nothing else; elsewhere they do what they always do.
   */
  onFollow?: (link: EditorLink) => void;
  /**
   * Answers the suggestion list that typing a link opens. Whether there is one at mount turns the
   * list on; each question goes to the current one.
   */
  suggest?: Suggest;
};

/**
 * A CodeMirror editor for one page's Markdown: plain, with the syntax visible, or with the live
 * preview when its state was created with it, in the editing or the reading view.
 */
export function MarkdownEditor({
  state,
  readOnly,
  reading = false,
  autoFocus = false,
  viewRef,
  onChange,
  onUnmount,
  onReplace,
  onFollow,
  suggest,
}: MarkdownEditorProps) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  // Only the state at mount counts: a later one, such as the state this editor reported when
  // React remounted it, must not replace the running editor.
  const [initialState] = useState(state);
  const [focusAtMount] = useState(autoFocus);
  const [suggestsAtMount] = useState(suggest !== undefined);
  const reportChange = useEffectEvent((next: EditorState) => onChange?.(next));
  const reportUnmount = useEffectEvent((last: EditorState) => onUnmount?.(last));
  const reportReplace = useEffectEvent((next: EditorState) => onReplace?.(next));
  /** Follows `link`, if there is one, and says whether it did. */
  const follow = useEffectEvent((link: EditorLink | null) => {
    if (!link || !onFollow) return false;
    onFollow(link);
    return true;
  });
  const askSuggest = useEffectEvent((query: string) => {
    // The list treats a failed question as no suggestions.
    if (!suggest) throw new Error("The editor no longer suggests pages.");
    return suggest(query);
  });
  const applyMode = useEffectEvent((editor: EditorView) =>
    setMode(editor, modeOf(reading, readOnly)),
  );
  const share = useEffectEvent((editor: EditorView | null) => {
    if (viewRef) viewRef.current = editor;
  });

  useEffect(() => {
    const editor = new EditorView({
      state: initialState,
      parent: parent.current ?? undefined,
      dispatchTransactions: (transactions, target) => {
        target.update(transactions);
        if (transactions.some((transaction) => transaction.docChanged)) reportChange(target.state);
      },
    });
    view.current = editor;
    share(editor);
    applyMode(editor);
    if (suggestsAtMount) {
      const ask: Suggest = async (query) => askSuggest(query);
      editor.dispatch({ effects: suggestion.reconfigure(suggestFacet.of(ask)) });
    }
    replaceListeners.set(editor, reportReplace);
    // The reading view follows only the resolved links it draws as focusable, by where they start.
    const readingLink = (target: EventTarget | null) => {
      const element = linkElement(editor, target);
      const start = element && linkStart(editor, element);
      const links = editor.state.field(editorLinks, false)?.links ?? [];
      const link = links.find((link) => link.from === start);
      return link?.state === "resolved" ? link : null;
    };
    // In the capture phase, before CodeMirror's own handlers, which leave alone an event whose
    // default is prevented: a click that follows a link does not also move the cursor.
    const followClick = (event: MouseEvent) => {
      const reading = isReading(editor.state);
      if (!isFollowClick(event, reading)) return;
      let link: EditorLink | null;
      if (reading) link = readingLink(event.target);
      else {
        const position =
          gridPosition(editor, event) ?? editor.posAtCoords({ x: event.clientX, y: event.clientY });
        link = position === null ? null : linkAt(editor.state, position);
      }
      if (follow(link)) event.preventDefault();
    };
    const followKey = (event: KeyboardEvent) => {
      const reading = isReading(editor.state);
      if (!isFollowKey(event, reading)) return;
      const link = reading
        ? readingLink(event.target)
        : linkAt(editor.state, editor.state.selection.main.head);
      if (follow(link)) event.preventDefault();
    };
    const container = parent.current;
    container?.addEventListener("mousedown", followClick, true);
    container?.addEventListener("keydown", followKey, true);
    if (focusAtMount) editor.focus();
    return () => {
      container?.removeEventListener("mousedown", followClick, true);
      container?.removeEventListener("keydown", followKey, true);
      replaceListeners.delete(editor);
      share(null);
      // The page resumes from this state, as when its tab comes back: with no suggestion list open,
      // since the list closes when the tab changes even while the editor keeps the focus.
      closeCompletion(editor);
      reportUnmount(editor.state);
      editor.destroy();
      view.current = null;
    };
  }, [initialState, focusAtMount, suggestsAtMount]);

  useEffect(() => {
    if (view.current) setMode(view.current, modeOf(reading, readOnly));
  }, [reading, readOnly]);

  return <div ref={parent} />;
}
