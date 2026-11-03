import { type EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { Properties } from "@/types/api";
import { frontmatterEnd } from "./editor-links";
import { previewView } from "./live-preview";

// The class names below are styled in the editor section of src/ui/theme.css.

/** The leading frontmatter's lines, its `---` lines included; empty when the page has none. */
export function frontmatterText(doc: Text) {
  const end = frontmatterEnd(doc);
  return end === 0 ? "" : doc.sliceString(0, doc.line(end).to);
}

/** The properties the core read from `text`, the frontmatter they belong to. */
const setPropertiesEffect = StateEffect.define<{ text: string; properties: Properties }>();
const toggleEffect = StateEffect.define<null>();

/** The effect that gives the editor the core's `properties` of the frontmatter `text`. */
export function setProperties(text: string, properties: Properties) {
  return setPropertiesEffect.of({ text, properties });
}

/**
 * The properties block: the frontmatter's rows below the title, with a heading that expands and
 * collapses them, or the frontmatter's text as typed when it cannot be read. It only draws: a
 * press on its heading changes nothing in the text or its history.
 */
class PropertiesWidget extends WidgetType {
  constructor(
    readonly properties: Properties,
    /** The frontmatter's lines between its `---` lines. */
    readonly source: string,
    readonly open: boolean,
  ) {
    super();
  }

  /** What the block shows besides whether it is open. */
  private get content() {
    return JSON.stringify([this.properties, this.properties.state === "source" ? this.source : ""]);
  }

  eq(other: PropertiesWidget) {
    return other.open === this.open && other.content === this.content;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-properties";
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "cm-properties-heading";
    heading.textContent = "Properties";
    heading.addEventListener("click", () => view.dispatch({ effects: toggleEffect.of(null) }));
    block.append(heading, this.body());
    contents.set(block, this.content);
    this.show(block);
    return block;
  }

  /** Opens or closes the drawn block in place, so its heading keeps focus. */
  updateDOM(block: HTMLElement) {
    if (contents.get(block) !== this.content) return false;
    this.show(block);
    return true;
  }

  private show(block: HTMLElement) {
    block.querySelector("button")?.setAttribute("aria-expanded", String(this.open));
    const body = block.lastElementChild;
    if (body instanceof HTMLElement) body.hidden = !this.open;
  }

  private body(): HTMLElement {
    const { properties } = this;
    if (properties.state !== "rows") {
      const source = document.createElement("pre");
      source.className = "cm-properties-source";
      source.textContent = this.source;
      return source;
    }
    const list = document.createElement("dl");
    list.className = "cm-properties-list";
    for (const { key, value } of properties.rows) {
      const term = document.createElement("dt");
      term.textContent = key;
      const description = document.createElement("dd");
      if (value.kind === "text") description.textContent = value.text;
      if (value.kind === "list") description.textContent = value.items.join(", ");
      if (value.kind === "yaml") {
        description.className = "cm-properties-yaml";
        description.textContent = value.text;
      }
      list.append(term, description);
    }
    return list;
  }

  ignoreEvent() {
    return true;
  }
}

/** What each drawn block shows besides whether it is open, so that opening keeps its elements. */
const contents = new WeakMap<HTMLElement, string>();

/** Hides the frontmatter while the core has not read it, or when it has no property. */
class EmptyWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    return document.createElement("div");
  }
}

type Block = {
  /** The frontmatter the properties are of, and what the core read from it. */
  read: { text: string; properties: Properties } | null;
  open: boolean;
  decorations: DecorationSet;
};

function decorations(state: EditorState, read: Block["read"], open: boolean): DecorationSet {
  const end = frontmatterEnd(state.doc);
  if (state.facet(previewView) !== "reading" || end === 0) return Decoration.none;
  const to = state.doc.line(end).to;
  const text = state.doc.sliceString(0, to);
  const properties = read?.text === text ? read.properties : null;
  const widget =
    properties === null || properties.state === "none"
      ? new EmptyWidget()
      : new PropertiesWidget(
          properties,
          end > 2 ? state.doc.sliceString(state.doc.line(2).from, state.doc.line(end - 1).to) : "",
          open,
        );
  return Decoration.set(Decoration.replace({ block: true, widget }).range(0, to));
}

/**
 * The reading view's properties block in place of the frontmatter's lines, collapsed when the
 * state is created. It shows what `setProperties` last gave for the frontmatter the page has now,
 * and nothing while the core has not read that.
 */
export const propertiesBlock = StateField.define<Block>({
  create: (state) => ({ read: null, open: false, decorations: decorations(state, null, false) }),
  update: (block, transaction) => {
    let { read, open } = block;
    for (const effect of transaction.effects) {
      if (effect.is(setPropertiesEffect)) read = effect.value;
      if (effect.is(toggleEffect)) open = !open;
    }
    const redraws =
      read !== block.read ||
      open !== block.open ||
      transaction.docChanged ||
      transaction.startState.facet(previewView) !== transaction.state.facet(previewView);
    if (!redraws) return block;
    return { read, open, decorations: decorations(transaction.state, read, open) };
  },
  provide: (field) => EditorView.decorations.from(field, (block) => block.decorations),
});

/**
 * The frontmatter whose properties the reading view needs from the core, or null when it needs
 * none: it shows no block, or the core already read the frontmatter the page has now.
 */
export function propertiesNeeded(state: EditorState): string | null {
  if (state.facet(previewView) !== "reading") return null;
  const text = frontmatterText(state.doc);
  if (text === "") return null;
  const block = state.field(propertiesBlock, false);
  return block && block.read?.text !== text ? text : null;
}
