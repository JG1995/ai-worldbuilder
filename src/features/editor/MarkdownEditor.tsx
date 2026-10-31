import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useEffectEvent, useRef, useState } from "react";

// The class names below are styled in the editor section of src/ui/theme.css.
const monoClass = "cm-mono";

/** Code spans and code block text take the `mono` type role. */
const codeHighlight = HighlightStyle.define([{ tag: tags.monospace, class: monoClass }]);

const monoLine = Decoration.line({ class: monoClass });

/** A block of lines from a first line of `---` to the next `---` line, as Obsidian reads it. */
function frontmatterDecorations(doc: Text): DecorationSet {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return Decoration.none;
  for (let end = 2; end <= doc.lines; end++) {
    if (doc.line(end).text.trimEnd() !== "---") continue;
    const builder = new RangeSetBuilder<Decoration>();
    for (let number = 1; number <= end; number++) {
      const line = doc.line(number);
      builder.add(line.from, line.from, monoLine);
    }
    return builder.finish();
  }
  return Decoration.none;
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

/** The editor state for a page's text; `label` names the editor for assistive technology. */
export function createPageState(text: string, label: string) {
  return EditorState.create({
    doc: text,
    extensions: [
      markdown(),
      syntaxHighlighting(codeHighlight),
      frontmatter,
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

type MarkdownEditorProps = {
  /** From `createPageState`. The editor starts from it when it mounts. */
  state: EditorState;
  readOnly: boolean;
  /** Receives the editor's last state when it unmounts, so the page can resume where it was. */
  onUnmount?: (state: EditorState) => void;
};

/** A plain CodeMirror editor for one page's Markdown, with the syntax visible. */
export function MarkdownEditor({ state, readOnly, onUnmount }: MarkdownEditorProps) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  // Only the state at mount counts: a later one, such as the state this editor reported when
  // React remounted it, must not replace the running editor.
  const [initialState] = useState(state);
  const reportUnmount = useEffectEvent((last: EditorState) => onUnmount?.(last));
  const applyReadOnly = useEffectEvent((editor: EditorView) => setReadOnly(editor, readOnly));

  useEffect(() => {
    const editor = new EditorView({ state: initialState, parent: parent.current ?? undefined });
    view.current = editor;
    applyReadOnly(editor);
    return () => {
      reportUnmount(editor.state);
      editor.destroy();
      view.current = null;
    };
  }, [initialState]);

  useEffect(() => {
    if (view.current) setReadOnly(view.current, readOnly);
  }, [readOnly]);

  return <div ref={parent} />;
}
