import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef, Tree } from "@lezer/common";
import type { ImageEmbed, ImageRequest } from "@/types/api";
import { glyphs } from "./icon-glyphs";
import { bodyStart, drawnImages, imageFile, previewView, revealedLines } from "./live-preview";

// The class names below are styled in the editor section of src/ui/theme.css.

/** The URL of the world's image at `path`, whose file has `stamp`. */
export type ImageUrl = (path: string, stamp: string) => string;

/** A size an embed asks for, in pixels: a width, or a width and a height to fit inside. */
type Size = { width: number; height: number | null };

/** An image embed of the text, and what its image shows with. */
type Embed = {
  from: number;
  to: number;
  request: ImageRequest;
  size: Size | null;
  /** The image's text alternative. */
  alt: string;
  /** What a placeholder calls the image: its alt text, or its file name. */
  name: string;
  /** The address a web image's placeholder shows. */
  address: string;
  /** The first and last line of the table the embed is in, if it is in one. */
  table: { first: number; last: number } | null;
};

/** A destination the core never loads: a web or `data:` address. */
const webAddress = /^(https?:|\/\/|data:)/i;
/** A size: a number, or two numbers joined by `x`. */
const sizePattern = /^\s*(\d+)(?:x(\d+))?\s*$/;
/** A Markdown image's alt text that ends in `|` and a size. */
const altWithSize = /^(.*)\|\s*(\d+)(?:x(\d+))?\s*$/s;

function sizeOf(width: string, height: string | undefined): Size {
  return { width: Number(width), height: height === undefined ? null : Number(height) };
}

/** The last segment of `target`, percent-decoded when it can be. */
function fileName(target: string) {
  const name = target.split("/").at(-1) ?? target;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** `![[target]]` or `![[target|part]]`, when the target names an image. */
function wikiEmbed(state: EditorState, node: SyntaxNodeRef): Omit<Embed, "table"> | null {
  // `![[` and `]]`.
  const inner = state.sliceDoc(node.from + 3, node.to - 2);
  const pipe = inner.indexOf("|");
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  if (!imageFile.test(target)) return null;
  const part = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
  const size = sizePattern.exec(part);
  const file = fileName(target);
  const alt = size || part === "" ? null : part;
  return {
    from: node.from,
    to: node.to,
    request: { target, form: "wiki" },
    size: size && sizeOf(size[1], size[2]),
    alt: alt ?? file.replace(/\.[^.]*$/, ""),
    name: alt ?? file,
    address: target,
  };
}

/** `![alt](destination)`, when the destination names an image or is a web address. */
function markdownImage(state: EditorState, node: SyntaxNodeRef): Omit<Embed, "table"> | null {
  const url = node.node.getChild("URL");
  const close = node.node
    .getChildren("LinkMark")
    .find((mark) => state.sliceDoc(mark.from, mark.to) === "]");
  if (!url || !close) return null;
  const destination = state.sliceDoc(url.from, url.to);
  const address = /^<.*>$/.test(destination) ? destination.slice(1, -1) : destination;
  if (!imageFile.test(address) && !webAddress.test(address)) return null;
  // `![`.
  let alt = state.sliceDoc(node.from + 2, close.from);
  let size: Size | null = null;
  const sized = altWithSize.exec(alt);
  if (sized) {
    alt = sized[1];
    size = sizeOf(sized[2], sized[3]);
  }
  alt = alt.trim();
  return {
    from: node.from,
    to: node.to,
    // The core decodes the destination and removes its brackets.
    request: { target: destination, form: "markdown" },
    size,
    alt,
    name: alt || fileName(address),
    address,
  };
}

/** Nodes whose text holds no embed that shows: code, raw HTML and comments. */
const noEmbeds = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "PageComment",
  "PageCommentBlock",
]);

/** The image embeds of `tree`, the syntax of `state`'s text, after any leading frontmatter. */
function embedsIn(state: EditorState, tree: Tree): Embed[] {
  const start = bodyStart(state);
  const embeds: Embed[] = [];
  let table: Embed["table"] = null;
  tree.iterate({
    from: start,
    enter: (node) => {
      if (node.to <= start) return false;
      if (node.from < start) return true;
      if (noEmbeds.has(node.name)) return false;
      if (node.name === "Table") {
        const { doc } = state;
        table = { first: doc.lineAt(node.from).number, last: doc.lineAt(node.to).number };
      }
      if (node.name !== "WikiEmbed" && node.name !== "Image") return true;
      const embed = node.name === "WikiEmbed" ? wikiEmbed(state, node) : markdownImage(state, node);
      if (embed) embeds.push({ ...embed, table });
      return false;
    },
    leave: (node) => {
      if (node.name === "Table") table = null;
    },
  });
  return embeds;
}

const keyOf = ({ form, target }: ImageRequest) => `${form}:${target}`;

/** How long finding the image embeds may parse a long page before it settles for what is parsed. */
const requestParseTimeout = 500;

/** What to ask the core for the image embeds of `state`'s text, each embed once, in order. */
export function imageRequests(state: EditorState): ImageRequest[] {
  const tree = ensureSyntaxTree(state, state.doc.length, requestParseTimeout) ?? syntaxTree(state);
  const requests = new Map<string, ImageRequest>();
  for (const { request } of embedsIn(state, tree)) requests.set(keyOf(request), request);
  return [...requests.values()];
}

const setImagesEffect = StateEffect.define<readonly [ImageRequest, ImageEmbed][]>();

/** The effect that gives the editor the core's `embeds`, what each of `requests` resolves to. */
export function setImages(requests: readonly ImageRequest[], embeds: readonly ImageEmbed[]) {
  return setImagesEffect.of(requests.map((request, index) => [request, embeds[index]]));
}

/** A placeholder's content: an icon and the message, both as text. */
function placeholderContent(icon: "image" | "broken_image", message: string) {
  const glyph = document.createElement("span");
  glyph.className = "icon";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = glyphs[icon];
  const text = document.createElement("span");
  text.textContent = message;
  return [glyph, text];
}

/** In place of an image that cannot show: an icon and a message in a dashed box. */
class PlaceholderWidget extends WidgetType {
  constructor(
    readonly icon: "image" | "broken_image",
    readonly message: string,
    readonly block: boolean,
  ) {
    super();
  }

  eq(other: PlaceholderWidget) {
    return other.icon === this.icon && other.message === this.message && other.block === this.block;
  }

  toDOM() {
    const box = document.createElement(this.block ? "div" : "span");
    box.className = "cm-image-placeholder";
    box.append(...placeholderContent(this.icon, this.message));
    return box;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * An image of the world at its natural size, or the size its embed asks for, never wider than the
 * page column or its grid cell. An image that cannot be loaded or decoded turns into the "cannot be
 * shown" placeholder. Sizes are the image's attributes: the content security policy blocks style
 * attributes.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly size: Size | null,
    readonly name: string,
    readonly block: boolean,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.size?.width === this.size?.width &&
      other.size?.height === this.size?.height &&
      other.name === this.name &&
      other.block === this.block
    );
  }

  toDOM(view: EditorView) {
    const frame = document.createElement(this.block ? "div" : "span");
    frame.className = "cm-image";
    const image = document.createElement("img");
    image.alt = this.alt;
    const { size } = this;
    if (size) image.width = size.width;
    if (size?.height) image.height = size.height;
    image.addEventListener("load", () => {
      // Within a width and a height, at the image's own ratio.
      if (size?.height && image.naturalWidth > 0 && image.naturalHeight > 0) {
        const ratio = image.naturalWidth / image.naturalHeight;
        image.width = Math.round(Math.min(size.width, size.height * ratio));
        image.removeAttribute("height");
      }
      view.requestMeasure();
    });
    image.addEventListener("error", () => {
      frame.className = "cm-image-placeholder";
      frame.replaceChildren(...placeholderContent("broken_image", cannotShow(this.name)));
      view.requestMeasure();
    });
    image.src = this.src;
    frame.append(image);
    return frame;
  }

  ignoreEvent() {
    return false;
  }
}

/** An image embed's name in the reading view while the core has not said what it is. */
class NameWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }

  eq(other: NameWidget) {
    return other.name === this.name;
  }

  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.name;
    return span;
  }
}

const cannotShow = (name: string) => `${name} cannot be shown.`;

/** The widget that shows `embed` as the core resolved it. */
function widgetOf(embed: Embed, resolution: ImageEmbed, url: ImageUrl, block: boolean) {
  switch (resolution.state) {
    case "found":
      return new ImageWidget(
        url(resolution.path, resolution.stamp),
        embed.alt,
        embed.size,
        embed.name,
        block,
      );
    case "missing":
      return new PlaceholderWidget("broken_image", `${embed.name} was not found.`, block);
    case "outside":
      return new PlaceholderWidget("image", `${embed.name} is not in this world.`, block);
    case "web":
      return new PlaceholderWidget("image", `Web images are not loaded: ${embed.address}`, block);
  }
}

const imageUrlFacet = Facet.define<ImageUrl, ImageUrl | null>({
  combine: (values) => values[0] ?? null,
});

type Images = {
  embeds: readonly Embed[];
  /** Where each embed starts. */
  starts: ReadonlySet<number>;
  /** What the core resolved each request to, by `keyOf`. */
  resolved: ReadonlyMap<string, ImageEmbed>;
  /** Which embeds show their source, as one key. */
  revealed: string;
  decorations: DecorationSet;
  /** The images in place of the embeds in tables, which the grids draw in their cells. */
  cells: DecorationSet;
};

/**
 * Which of `embeds` show their source, as one key: those on a line that holds part of the cursor
 * or the selection, and those in a table that does, which shows as Markdown.
 */
function revealedKey(state: EditorState, embeds: readonly Embed[]) {
  const revealed = revealedLines(state);
  if (revealed.size === 0) return "";
  const { doc } = state;
  return embeds
    .map(({ from, to, table }) => {
      const first = table?.first ?? doc.lineAt(from).number;
      const last = table?.last ?? doc.lineAt(to).number;
      for (let number = first; number <= last; number++) if (revealed.has(number)) return "1";
      return "0";
    })
    .join("");
}

function images(
  state: EditorState,
  embeds: readonly Embed[],
  resolved: ReadonlyMap<string, ImageEmbed>,
): Images {
  const url = state.facet(imageUrlFacet);
  const revealed = revealedKey(state, embeds);
  const reading = state.facet(previewView) === "reading";
  const { doc } = state;
  const ranges: Range<Decoration>[] = [];
  const cells: Range<Decoration>[] = [];
  embeds.forEach((embed, index) => {
    const resolution = resolved.get(keyOf(embed.request));
    const inline = (() => {
      if (resolution && url) return widgetOf(embed, resolution, url, false);
      return reading ? new NameWidget(embed.name) : null;
    })();
    const shown = revealed[index] === "1";
    if (embed.table) {
      if (inline) cells.push(Decoration.replace({ widget: inline }).range(embed.from, embed.to));
      if (!shown) return;
    }
    const line = doc.lineAt(embed.from);
    // A widget in place of text across a line end is not drawn, as the live preview's are not.
    if (embed.to > line.to) return;
    if (!shown) {
      if (inline) ranges.push(Decoration.replace({ widget: inline }).range(embed.from, embed.to));
    } else if (resolution && url) {
      const widget = widgetOf(embed, resolution, url, true);
      ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
    }
  });
  return {
    embeds,
    starts: new Set(embeds.map((embed) => embed.from)),
    resolved,
    revealed,
    decorations: Decoration.set(ranges, true),
    cells: Decoration.set(cells, true),
  };
}

const imagesField = StateField.define<Images>({
  create: (state) => images(state, embedsIn(state, syntaxTree(state)), new Map()),
  update: (value, transaction) => {
    const { startState, state } = transaction;
    let { resolved } = value;
    for (const effect of transaction.effects) {
      if (!effect.is(setImagesEffect)) continue;
      const next = new Map(resolved);
      for (const [request, embed] of effect.value) next.set(keyOf(request), embed);
      resolved = next;
    }
    const rescan = transaction.docChanged || syntaxTree(startState) !== syntaxTree(state);
    const embeds = rescan ? embedsIn(state, syntaxTree(state)) : value.embeds;
    const redraws =
      rescan ||
      resolved !== value.resolved ||
      startState.facet(previewView) !== state.facet(previewView) ||
      startState.facet(imageUrlFacet) !== state.facet(imageUrlFacet) ||
      revealedKey(state, embeds) !== value.revealed;
    return redraws ? images(state, embeds, resolved) : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The images in place of the embeds in tables, for the grids to draw in their cells. */
export function imageCells(state: EditorState): DecorationSet {
  return state.field(imagesField, false)?.cells ?? Decoration.none;
}

/** Whether every grid's images may draw differently: new resolutions, or images switched on. */
export function imagesRedraw(startState: EditorState, state: EditorState) {
  return (
    startState.field(imagesField, false)?.resolved !== state.field(imagesField, false)?.resolved ||
    startState.facet(imageUrlFacet) !== state.facet(imageUrlFacet)
  );
}

/**
 * Image embeds drawn as their images, each with the URL `url` gives, as `setImages` last resolved
 * them: in place of the embed on lines that hold no part of the cursor or the selection, and in
 * the reading view; below the line on lines that do, where the embed shows as typed. An embed the
 * core is not known to resolve yet shows as typed, or as its name in the reading view. The images
 * only draw: the text keeps every character.
 */
export function imageEmbeds(url: ImageUrl): Extension {
  return [
    imageUrlFacet.of(url),
    imagesField,
    drawnImages.of((state, from) => state.field(imagesField, false)?.starts.has(from) ?? false),
  ];
}
