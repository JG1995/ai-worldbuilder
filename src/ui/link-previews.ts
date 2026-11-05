import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  repositionTooltips,
  showTooltip,
  type Tooltip,
  type TooltipView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { EditorLink, ImageEmbed, ImageRequest } from "@/types/api";
import { editorLinks, findAnchor, setLinks } from "./editor-links";
import { imageRequests, setImages } from "./image-embeds";
import { gridTextStart } from "./table-grid";

// The class names below are styled in the editor section of src/ui/theme.css.

/** What a preview of a linked page reads and draws with, which `MarkdownEditor` gives. */
export type PreviewSource = {
  /** The text of the page at `path` as last saved; rejects when it cannot be read. */
  read: (path: string) => Promise<string>;
  /** A state of `text` in the reading view, named `title`, with the page's images. */
  page: (text: string, title: string) => EditorState;
  /** The core's links of `text`, the page at `path`'s; none are marked without it. */
  links?: (path: string, text: string) => Promise<readonly EditorLink[]>;
  /** What the image embeds of the page at `path` resolve to; none show without it. */
  images?: (path: string, embeds: ImageRequest[]) => Promise<ImageEmbed[]>;
  /** Follows `link`, as a click on its preview asks. */
  follow: (link: EditorLink) => void;
};

/** How long the pointer rests on a link before its preview opens, as tooltips wait. */
const previewDelay = 500;
/** How long a read may take before the preview says it is loading. */
const loadingDelay = 300;

const setPreview = StateEffect.define<Tooltip | null>();

/** The effect that closes any open preview, as following a link does. */
export const closeLinkPreview = setPreview.of(null);

/** The open preview, which any change to the text or the selection closes. */
const previewField = StateField.define<Tooltip | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setPreview)) return effect.value;
    return transaction.docChanged || transaction.selection ? null : value;
  },
  provide: (field) => showTooltip.from(field),
});

/** The page's name, as its tab shows it. */
function titleOf(path: string) {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

/** A resolved link that the pointer is on, and the drawn element of it under the pointer. */
type Hovered = { link: EditorLink & { path: string }; element: Element };

/**
 * The resolved wiki link or page embed that `target` is part of in `view`'s text, in a line or a
 * grid's cell. Unresolved links, attachments and web links have none: only resolved links carry
 * the `cm-link` mark.
 */
function hoveredAt(view: EditorView, target: EventTarget | null): Hovered | null {
  const element = target instanceof Element ? target.closest(".cm-link") : null;
  if (!element || !view.contentDOM.contains(element)) return null;
  const position = gridTextStart(view, element) ?? view.posAtDOM(element);
  const links = view.state.field(editorLinks, false)?.links ?? [];
  const link = links.find(({ from, to }) => from <= position && position < to);
  if (link?.state !== "resolved" || link.path === null) return null;
  return { link: { ...link, path: link.path }, element };
}

/**
 * The preview's popover: the page's title, then a line while it loads or when it cannot show, or
 * the page's text in the reading view, scrolled to the linked heading or block. The nested editor
 * is destroyed with the popover.
 */
class PreviewPanel implements TooltipView {
  readonly dom = document.createElement("div");
  private readonly body = document.createElement("div");
  private page: EditorView | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly hovered: Hovered,
    private readonly source: PreviewSource,
  ) {
    this.dom.className = "cm-link-preview";
    const title = document.createElement("p");
    title.className = "cm-link-preview-title";
    title.textContent = titleOf(hovered.link.path);
    this.body.className = "cm-link-preview-body";
    this.dom.append(title, this.body);
    // A press neither moves the focus nor selects; a click follows the link. Both are left to the
    // page's scrollbar, which on WebKit a cancelled press cannot drag.
    this.dom.addEventListener("mousedown", (event) => {
      if (!this.onScrollbar(event)) event.preventDefault();
    });
    this.dom.addEventListener("click", (event) => {
      if (event.button === 0 && !this.onScrollbar(event)) source.follow(hovered.link);
    });
  }

  /** Whether `event` is on the page's scrolling element itself, as a press on its scrollbar is. */
  private onScrollbar(event: Event) {
    return this.page !== null && event.target === this.page.scrollDOM;
  }

  /** Beside the drawn link, which in a grid is not where its text would be. */
  getCoords = (pos: number) => {
    const { element } = this.hovered;
    if (element.isConnected) return element.getBoundingClientRect();
    return this.view.coordsAtPos(pos) ?? new DOMRect();
  };

  /** A line in place of the page's text. */
  showLine(text: string) {
    const line = document.createElement("p");
    line.className = "cm-link-preview-line";
    line.textContent = text;
    this.body.replaceChildren(line);
    repositionTooltips(this.view);
  }

  /** The page's `text` in the reading view, with its links and images once the core says them. */
  showText(text: string) {
    if (/^\s*$/.test(text)) {
      this.showLine("This page has no text yet.");
      return;
    }
    const { link } = this.hovered;
    const page = new EditorView({
      state: this.source.page(text, titleOf(link.path)),
      parent: this.body,
    });
    this.page = page;
    this.body.replaceChildren(page.dom);
    const anchor = findAnchor(page.state, link);
    if (anchor !== null) {
      page.requestMeasure({
        read: (nested) => nested.lineBlockAt(anchor).top,
        write: (top, nested) => {
          nested.scrollDOM.scrollTop = top;
        },
      });
    }
    const current = () => (this.page === page ? page : null);
    this.source.links?.(link.path, text).then(
      (links) => current()?.dispatch({ effects: setLinks(links) }),
      () => {},
    );
    const embeds = imageRequests(page.state);
    if (this.source.images && embeds.length > 0) {
      this.source.images(link.path, embeds).then(
        (resolved) => current()?.dispatch({ effects: setImages(embeds, resolved) }),
        () => {},
      );
    }
    repositionTooltips(this.view);
  }

  destroy() {
    this.page?.destroy();
    this.page = null;
  }
}

/**
 * Opens a link's preview once the pointer has rested on it for the preview delay, and closes it
 * when the pointer leaves both the link and the preview, on Escape, on Tab (keyboard previews are
 * not offered, so the keyboard never enters one), on a scroll outside it, on any change to the
 * text or the selection, and when the editor goes.
 */
function previewPlugin(source: PreviewSource) {
  return ViewPlugin.fromClass(
    class {
      hovered: Hovered | null = null;
      panel: PreviewPanel | null = null;
      timer: number | undefined;
      loadingTimer: number | undefined;
      /** Counts the previews asked for, so a late read of an old one is dropped. */
      asked = 0;

      constructor(readonly view: EditorView) {
        view.contentDOM.addEventListener("mouseover", this.enter);
        view.contentDOM.addEventListener("mouseout", this.leave);
      }

      /** Whether `node` is the hovered link's or inside the open preview. */
      keeps(node: EventTarget | null) {
        if (!this.hovered) return false;
        if (node instanceof Node && this.panel?.dom.contains(node)) return true;
        return hoveredAt(this.view, node)?.link.from === this.hovered.link.from;
      }

      enter = (event: MouseEvent) => {
        const hovered = hoveredAt(this.view, event.target);
        if (!hovered || hovered.link.from === this.hovered?.link.from) return;
        this.close();
        this.hovered = hovered;
        this.timer = window.setTimeout(this.open, previewDelay);
        document.addEventListener("keydown", this.closeOnKey, true);
        document.addEventListener("scroll", this.closeOnScroll, true);
      };

      leave = (event: MouseEvent) => {
        if (!this.keeps(event.relatedTarget)) this.close();
      };

      leavePanel = (event: MouseEvent) => {
        if (!this.keeps(event.relatedTarget)) this.close();
      };

      closeOnKey = (event: KeyboardEvent) => {
        const focusMove = event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (event.key === "Escape" || focusMove) this.close();
      };

      closeOnScroll = (event: Event) => {
        if (!(event.target instanceof Node && this.panel?.dom.contains(event.target))) this.close();
      };

      open = () => {
        const { hovered } = this;
        if (!hovered) return;
        const asked = ++this.asked;
        let loading = false;
        const show = () => {
          const panel = new PreviewPanel(this.view, hovered, source);
          panel.dom.addEventListener("mouseleave", this.leavePanel);
          this.panel = panel;
          const tooltip: Tooltip = {
            pos: hovered.link.from,
            end: hovered.link.to,
            create: () => panel,
          };
          this.view.dispatch({ effects: setPreview.of(tooltip) });
          return panel;
        };
        this.loadingTimer = window.setTimeout(() => {
          loading = true;
          show().showLine("Loading…");
        }, loadingDelay);
        source.read(hovered.link.path).then(
          (text) => {
            if (asked !== this.asked) return;
            window.clearTimeout(this.loadingTimer);
            (loading && this.panel ? this.panel : show()).showText(text);
          },
          () => {
            if (asked !== this.asked) return;
            window.clearTimeout(this.loadingTimer);
            (loading && this.panel ? this.panel : show()).showLine(
              "This page cannot be previewed.",
            );
          },
        );
      };

      /** Forgets the hovered link and any preview of it, without a transaction. */
      reset() {
        window.clearTimeout(this.timer);
        window.clearTimeout(this.loadingTimer);
        this.asked++;
        this.hovered = null;
        this.panel = null;
        document.removeEventListener("keydown", this.closeOnKey, true);
        document.removeEventListener("scroll", this.closeOnScroll, true);
      }

      close() {
        const shown = this.view.state.field(previewField) !== null;
        this.reset();
        if (shown) this.view.dispatch({ effects: closeLinkPreview });
      }

      update(update: ViewUpdate) {
        const closed =
          update.startState.field(previewField) !== null &&
          update.state.field(previewField) === null;
        if (closed || update.docChanged || update.selectionSet) this.reset();
      }

      destroy() {
        this.reset();
        this.view.contentDOM.removeEventListener("mouseover", this.enter);
        this.view.contentDOM.removeEventListener("mouseout", this.leave);
      }
    },
  );
}

/**
 * Previews of the pages that resolved wiki links and page embeds lead to, in a line or a grid's
 * cell, in either view: the page as last saved, read through `source`, which writes nothing.
 */
export function linkPreviews(source: PreviewSource) {
  return [previewField, previewPlugin(source)];
}
