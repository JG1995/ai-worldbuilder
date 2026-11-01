import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateField, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";
import type { EditorLink } from "@/types/api";
import { editorLinks, frontmatterEnd, linkAt } from "./editor-links";

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

const readOnlyMode = new Compartment();
function setReadOnly(editor: EditorView, readOnly: boolean) {
  if (editor.state.readOnly === readOnly) return;
  editor.dispatch({ effects: readOnlyMode.reconfigure(EditorState.readOnly.of(readOnly)) });
}

/**
 * The editor state for a page's text, with the cursor at `cursor` (the start by default); `label`
 * names the editor for assistive technology.
 */
export function createPageState(text: string, label: string, cursor = 0) {
  return EditorState.create({
    doc: text,
    selection: { anchor: cursor },
    extensions: [
      markdown(),
      syntaxHighlighting(codeHighlight),
      frontmatter,
      editorLinks,
      EditorView.lineWrapping,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editorAttributes.of({ class: "page-editor" }),
      EditorView.contentAttributes.of({ "aria-label": label }),
      readOnlyMode.of(EditorState.readOnly.of(false)),
      // Every editor carries it, because CodeMirror creates its element for the first one to mount.
      EditorView.cspNonce.of(styleNonce()),
    ],
  });
}

/**
 * A fresh state for the page's new `text`, with no undo history, and the cursor at the line and
 * column it had in `previous`, or at the nearest position the new text has.
 */
export function reloadedState(previous: EditorState, text: string, label: string) {
  const head = previous.selection.main.head;
  const { number, from } = previous.doc.lineAt(head);
  const doc = Text.of(text.split("\n"));
  const line = doc.line(Math.min(number, doc.lines));
  return createPageState(text, label, Math.min(line.from + head - from, line.to));
}

/** What each mounted editor reports a state that `replaceState` put in it to. */
const replaceListeners = new WeakMap<EditorView, (state: EditorState) => void>();

/**
 * Puts `state` in the running editor in place of its own, keeping whether it is read-only, and
 * reports it through the editor's `onReplace`.
 */
export function replaceState(editor: EditorView, state: EditorState) {
  const readOnly = editor.state.readOnly;
  editor.setState(state);
  setReadOnly(editor, readOnly);
  replaceListeners.get(editor)?.(editor.state);
}

/** Whether a mouse down asks to follow a link: the primary button with Ctrl or Cmd alone. */
function isFollowClick(event: MouseEvent) {
  return event.button === 0 && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey;
}

/** Whether a key press asks to follow a link: Alt/Option+Enter alone. */
function isFollowKey(event: KeyboardEvent) {
  return (
    event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
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
   * Receives a link to follow: Ctrl/Cmd+click on it, or Alt/Option+Enter with the cursor in it.
   * Either then does nothing else; elsewhere both do what they always do.
   */
  onFollow?: (link: EditorLink) => void;
};

/** A plain CodeMirror editor for one page's Markdown, with the syntax visible. */
export function MarkdownEditor({
  state,
  readOnly,
  autoFocus = false,
  viewRef,
  onChange,
  onUnmount,
  onReplace,
  onFollow,
}: MarkdownEditorProps) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  // Only the state at mount counts: a later one, such as the state this editor reported when
  // React remounted it, must not replace the running editor.
  const [initialState] = useState(state);
  const [focusAtMount] = useState(autoFocus);
  const reportChange = useEffectEvent((next: EditorState) => onChange?.(next));
  const reportUnmount = useEffectEvent((last: EditorState) => onUnmount?.(last));
  const reportReplace = useEffectEvent((next: EditorState) => onReplace?.(next));
  /** Follows the link at `position`, if there is one, and says whether it did. */
  const follow = useEffectEvent((editor: EditorView, position: number | null) => {
    const link = position === null ? null : linkAt(editor.state, position);
    if (!link || !onFollow) return false;
    onFollow(link);
    return true;
  });
  const applyReadOnly = useEffectEvent((editor: EditorView) => setReadOnly(editor, readOnly));
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
    applyReadOnly(editor);
    replaceListeners.set(editor, reportReplace);
    // In the capture phase, before CodeMirror's own handlers, which leave alone an event whose
    // default is prevented: a click that follows a link does not also move the cursor.
    const followClick = (event: MouseEvent) => {
      if (!isFollowClick(event)) return;
      const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
      if (follow(editor, position)) event.preventDefault();
    };
    const followKey = (event: KeyboardEvent) => {
      if (isFollowKey(event) && follow(editor, editor.state.selection.main.head)) {
        event.preventDefault();
      }
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
      reportUnmount(editor.state);
      editor.destroy();
      view.current = null;
    };
  }, [initialState, focusAtMount]);

  useEffect(() => {
    if (view.current) setReadOnly(view.current, readOnly);
  }, [readOnly]);

  return <div ref={parent} />;
}
