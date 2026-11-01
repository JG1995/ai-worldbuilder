import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import type { LinkSuggestion, LinkSuggestions } from "@/types/api";
import { frontmatterEnd } from "./editor-links";

// The class names below are styled in the editor section of src/ui/theme.css.

/** Asks for the pages to suggest for a link whose page part so far is `query`. */
export type Suggest = (query: string) => Promise<LinkSuggestions>;

/** The function the suggestion list asks. Without one, the list never opens. */
export const suggestFacet = Facet.define<Suggest, Suggest | null>({
  combine: (values) => values[0] ?? null,
});

/** The heading over the suggestions while the world's index is being built. */
export const indexingHeading = "Indexing world…";

/** The one row of a list in which no page matches. */
export const noMatchLabel = "No page matches";

/** `[[` with the link's page part so far, up to the cursor: none of `[`, `]`, `|` or `#`. */
const openLink = /\[\[[^[\]|#]*$/;

/** Syntax tree nodes whose text is code, where nothing is a link. */
const codeNodes = new Set(["InlineCode", "FencedCode", "CodeBlock"]);

function inCode(state: EditorState, position: number) {
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, -1);
  for (; node; node = node.parent) {
    if (codeNodes.has(node.name)) return true;
  }
  return false;
}

function inFrontmatter(state: EditorState, position: number) {
  return state.doc.lineAt(position).number <= frontmatterEnd(state.doc);
}

/** A suggestion row: the alias it matched by, if any, shows beside the name and folder. */
type LinkCompletion = Completion & { alias?: string };

/** The folder of a page path, empty at the world's top level. */
function folderOf(path: string) {
  const end = path.lastIndexOf("/");
  return end === -1 ? "" : path.slice(0, end);
}

/**
 * Writes `insert` and `]]` in place of the link's page part typed so far, from `from` to `to`, and
 * of a `]]` that already follows it, and puts the cursor after the `]]`.
 */
function insertLink(view: EditorView, insert: string, from: number, to: number) {
  const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
  const text = `${insert}]]`;
  view.dispatch({
    changes: { from, to: end, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  });
}

function suggestionRow(suggestion: LinkSuggestion): LinkCompletion {
  return {
    label: suggestion.name,
    detail: folderOf(suggestion.path) || undefined,
    alias: suggestion.alias ?? undefined,
    apply: (view, _completion, from, to) => insertLink(view, suggestion.insert, from, to),
  };
}

const noMatchRow = (): LinkCompletion => ({
  label: noMatchLabel,
  apply: (view) => {
    closeCompletion(view);
  },
});

/**
 * The rows of each editor's last answer, by query and row. The list keeps its selected row across
 * a new answer only when that answer holds the very same row object, so an answer that the index
 * changing asks for again reuses them; another query starts with new rows, selecting the first.
 */
const lastRows = new WeakMap<EditorView, Map<string, LinkCompletion>>();

function rowsFor(view: EditorView | undefined, query: string, answer: LinkSuggestions) {
  const previous = (view && lastRows.get(view)) || new Map<string, LinkCompletion>();
  const rows = new Map<string, LinkCompletion>();
  const section = answer.indexing ? indexingHeading : undefined;
  const add = (key: string, row: () => LinkCompletion) => {
    const reused = previous.get(key) ?? row();
    // A row keeps its identity when the heading goes, once the index is built.
    reused.section = section;
    rows.set(key, reused);
  };
  for (const item of answer.items) {
    add(JSON.stringify([query, item.path, item.alias, item.insert]), () => suggestionRow(item));
  }
  if (rows.size === 0) add(JSON.stringify([query]), noMatchRow);
  if (view) lastRows.set(view, rows);
  return [...rows.values()];
}

/**
 * Suggests pages while the text before the cursor on its line ends in `[[` or `![[` and the link's
 * page part so far, outside code and the frontmatter. The core ranks them, so the list keeps its
 * order and filters nothing.
 */
export async function linkCompletions(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const suggest = context.state.facet(suggestFacet);
  const typed = context.matchBefore(openLink);
  if (!suggest || !typed) return null;
  if (inFrontmatter(context.state, context.pos) || inCode(context.state, context.pos)) return null;
  const from = typed.from + 2;
  const query = context.state.sliceDoc(from, context.pos);
  let answer: LinkSuggestions;
  try {
    answer = await suggest(query);
  } catch {
    return null;
  }
  return { from, options: rowsFor(context.view, query, answer), filter: false };
}

function aliasOf(completion: LinkCompletion) {
  if (!completion.alias) return null;
  const alias = document.createElement("span");
  alias.className = "cm-completionAlias";
  alias.textContent = `alias: ${completion.alias}`;
  return alias;
}

/**
 * The suggestion list for links, asking the function in `suggestFacet`. Up and Down move the
 * selection, Enter and Tab pick, and Escape closes; elsewhere Enter and Tab do what they always do.
 */
export const linkSuggestions = [
  autocompletion({
    override: [linkCompletions],
    icons: false,
    // Each keystroke asks at once: the core answers within the DESIGN's 100 ms, which the
    // package's own pause of 100 ms would use up.
    activateOnTypingDelay: 0,
    // After the detail (the folder), which the package places at 80.
    addToOptions: [{ render: aliasOf, position: 90 }],
  }),
  Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
];
