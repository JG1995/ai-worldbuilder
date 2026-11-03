import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { frontmatterEnd } from "./editor-links";
import { glyphs } from "./icon-glyphs";
import { placeInViewport } from "./Tooltip";

// The class names below are styled in the editor section of src/ui/theme.css.

/** A web link in the text: its syntax node's range and the address it opens. */
export type WebLink = { from: number; to: number; address: string };

/**
 * Whether web links show and open as links. `MarkdownEditor` turns them on when it is given
 * `onOpenWeb`; without it they show as plain text.
 */
export const webLinksShown = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** A backslash escape in a link destination: a backslash before ASCII punctuation. */
const escapes = /\\([!-/:-@[-`{-~])/g;

/**
 * `address` when it is what the core opens: an absolute http or https URL with a host, with no
 * whitespace or control character; otherwise null.
 */
function opensAs(address: string): string | null {
  if (/[\s\p{Cc}]/u.test(address)) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const web = url.protocol === "http:" || url.protocol === "https:";
  return web && url.hostname !== "" ? address : null;
}

/**
 * The node of the web link `node` is part of: an inline link or an autolink, or a bare address (a
 * GFM autolink literal) in neither. Nothing in an image is a web link.
 */
function linkNodeOf(node: SyntaxNode): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let at: SyntaxNode | null = node; at; at = at.parent) {
    if (at.name === "Image") return null;
    if (at.name === "Link" || at.name === "Autolink") found = at;
    else if (at.name === "URL" && !found) found = at;
  }
  return found;
}

/** The address of a `Link`, `Autolink` or bare `URL` node, if it opens in the browser. */
function addressOf(state: EditorState, node: SyntaxNode): string | null {
  const text = (from: number, to: number) => state.sliceDoc(from, to);
  if (node.name === "URL") {
    const written = text(node.from, node.to);
    // GFM reads `www.` as `http://www.`.
    return opensAs(/^www\./i.test(written) ? `http://${written}` : written);
  }
  if (node.name === "Autolink") {
    const url = node.getChild("URL");
    return url && opensAs(text(url.from, url.to));
  }
  // An inline link, `[text](destination)`, not a reference link. Its text can hold a bare address
  // of its own, so the destination is the address right after the `(`.
  const marks = node.getChildren("LinkMark");
  const close = marks.find((mark) => text(mark.from, mark.to) === "]");
  const open = marks.find((mark) => text(mark.from, mark.to) === "(");
  if (!close || !open || open.from !== close.to) return null;
  const url = node.getChildren("URL").find((child) => child.from === open.to);
  if (!url) return null;
  const destination = text(url.from, url.to);
  const bare = /^<.*>$/.test(destination) ? destination.slice(1, -1) : destination;
  return opensAs(bare.replace(escapes, "$1"));
}

/**
 * The address that `node` opens when it is a whole web link itself: an inline link, autolink or
 * bare address whose address uses http or https. Null for anything else, such as a bare address
 * inside a link's text, which belongs to the link.
 */
export function webAddress(state: EditorState, node: SyntaxNode): string | null {
  const link = linkNodeOf(node);
  const itself = link?.name === node.name && link.from === node.from && link.to === node.to;
  return itself ? addressOf(state, node) : null;
}

/**
 * The web link that `position` is in or at an end of, outside any leading frontmatter: the one
 * starting there before one ending there, so a link's start finds that link.
 */
export function webLinkAt(state: EditorState, position: number): WebLink | null {
  const end = frontmatterEnd(state.doc);
  if (end > 0 && position <= state.doc.line(end).to) return null;
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    const node = linkNodeOf(tree.resolveInner(position, side));
    const address = node && addressOf(state, node);
    if (node && address) return { from: node.from, to: node.to, address };
  }
  return null;
}

/**
 * The `open_in_new` icon after a web link's text. The glyph is drawn from its attribute by the
 * style sheet, so the link's text stays its text. A press on it is the link's.
 */
export class WebIconWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const icon = document.createElement("span");
    icon.className = "cm-web-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("data-icon", glyphs.open_in_new);
    return icon;
  }

  ignoreEvent() {
    return false;
  }
}

/** As src/ui/Tooltip.tsx shows its tooltips. */
const tooltipDelay = 500;

/** The drawn web link that `target` is in, which carries its address. */
function addressElement(view: EditorView, target: EventTarget | null) {
  const element = target instanceof Element ? target.closest("[data-address]") : null;
  return element && view.contentDOM.contains(element) ? element : null;
}

/**
 * A tooltip with a web link's address, after the tooltip delay while the pointer is on the link,
 * or while the link has keyboard focus in the reading view. It closes when the pointer leaves or
 * the focus goes, on Escape, on a scroll and on any change to the text.
 */
const addressTooltip = ViewPlugin.fromClass(
  class {
    readonly tooltip = document.createElement("div");
    anchor: Element | null = null;
    timer: number | undefined;

    constructor(readonly view: EditorView) {
      this.tooltip.className = "cm-web-tooltip";
      this.tooltip.setAttribute("role", "tooltip");
      this.tooltip.hidden = true;
      view.dom.append(this.tooltip);
      view.contentDOM.addEventListener("mouseover", this.enter);
      view.contentDOM.addEventListener("focusin", this.enter);
      view.contentDOM.addEventListener("mouseout", this.leave);
      view.contentDOM.addEventListener("focusout", this.leave);
    }

    enter = (event: Event) => {
      const link = addressElement(this.view, event.target);
      if (!link || link === this.anchor) return;
      this.hide();
      this.anchor = link;
      this.timer = window.setTimeout(this.show, tooltipDelay);
    };

    leave = (event: Event) => {
      const next = (event as MouseEvent | FocusEvent).relatedTarget;
      if (this.anchor && next instanceof Node && this.anchor.contains(next)) return;
      this.hide();
    };

    closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.hide();
    };

    show = () => {
      const { anchor, tooltip } = this;
      if (!anchor?.isConnected) {
        this.hide();
        return;
      }
      tooltip.textContent = anchor.getAttribute("data-address");
      tooltip.hidden = false;
      // Through the CSSOM: the content security policy blocks style attributes.
      const place = placeInViewport(
        tooltip.getBoundingClientRect(),
        anchor.getBoundingClientRect(),
        "center",
      );
      tooltip.style.left = `${place.left}px`;
      tooltip.style.top = `${place.top}px`;
      document.addEventListener("keydown", this.closeOnEscape);
      document.addEventListener("scroll", this.hide, true);
    };

    hide = () => {
      window.clearTimeout(this.timer);
      this.anchor = null;
      this.tooltip.hidden = true;
      document.removeEventListener("keydown", this.closeOnEscape);
      document.removeEventListener("scroll", this.hide, true);
    };

    update(update: ViewUpdate) {
      if (update.docChanged) this.hide();
    }

    destroy() {
      this.hide();
      this.tooltip.remove();
      const content = this.view.contentDOM;
      content.removeEventListener("mouseover", this.enter);
      content.removeEventListener("focusin", this.enter);
      content.removeEventListener("mouseout", this.leave);
      content.removeEventListener("focusout", this.leave);
    }
  },
);

/** Web links shown as links, with their address in a tooltip; the editor opens them. */
export const webLinks = [webLinksShown.of(true), addressTooltip];
