import {
  type BlockContext,
  GFM,
  type InlineContext,
  type Line,
  type MarkdownConfig,
  type MarkdownExtension,
} from "@lezer/markdown";

const bang = 33; // !
const hash = 35; // #
const percent = 37; // %
const equals = 61; // =
const openBracket = 91; // [
const closeBracket = 93; // ]
const caret = 94; // ^
const newline = 10;

/**
 * Wiki links and embeds: `[[…]]` and `![[…]]` on one line, each one node with its brackets as
 * marks. Installed before CommonMark's links, so neither ever becomes a `Link` or `Image`.
 */
const wikiLinks: MarkdownConfig = {
  defineNodes: ["WikiLink", "WikiEmbed", "WikiLinkMark"],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        const embed = next === bang;
        const open = embed ? pos + 1 : pos;
        if (!embed && next !== openBracket) return -1;
        if (cx.char(open) !== openBracket || cx.char(open + 1) !== openBracket) return -1;
        const start = open + 2;
        for (let at = start; at < cx.end; at++) {
          const char = cx.char(at);
          if (char === newline) return -1;
          if (char !== closeBracket || cx.char(at + 1) !== closeBracket) continue;
          if (at === start) return -1;
          const end = at + 2;
          return cx.addElement(
            cx.elt(embed ? "WikiEmbed" : "WikiLink", pos, end, [
              cx.elt("WikiLinkMark", pos, start),
              cx.elt("WikiLinkMark", at, end),
            ]),
          );
        }
        return -1;
      },
    },
  ],
};

/** Whether the text around a two-character delimiter at `pos` lets it open and close a span. */
function flanking(cx: InlineContext, pos: number) {
  const before = cx.slice(pos - 1, pos);
  const after = cx.slice(pos + 2, pos + 3);
  const spaceBefore = /\s|^$/.test(before);
  const spaceAfter = /\s|^$/.test(after);
  const punctuationBefore = /\p{P}|\p{S}/u.test(before);
  const punctuationAfter = /\p{P}|\p{S}/u.test(after);
  return {
    open: !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore),
    close: !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter),
  };
}

const highlightDelimiter = { resolve: "Highlight", mark: "HighlightMark" };

/** Highlights, `==text==`, with the delimiter rules of GFM's strikethrough. */
const highlights: MarkdownConfig = {
  defineNodes: ["Highlight", "HighlightMark"],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== equals || cx.char(pos + 1) !== equals || cx.char(pos + 2) === equals) {
          return -1;
        }
        const { open, close } = flanking(cx, pos);
        return cx.addDelimiter(highlightDelimiter, pos, pos + 2, open, close);
      },
    },
  ],
};

/** Whether `text` holds `%%` at `from`. */
function opensComment(text: string, from: number) {
  return text.charCodeAt(from) === percent && text.charCodeAt(from + 1) === percent;
}

/** Whether a line of `text` ends in a `%%` that starts at or after `from`. */
function closesComment(text: string, from: number) {
  const trimmed = text.trimEnd();
  return trimmed.length - from >= 2 && trimmed.endsWith("%%");
}

/**
 * Comments: `%%…%%` inside a paragraph, and a block from a line starting `%%` to the next line
 * ending `%%`, or to the end of the page when no line closes it, as Obsidian reads them. Nothing
 * inside a comment is parsed.
 */
const comments: MarkdownConfig = {
  defineNodes: ["PageComment", { name: "PageCommentBlock", block: true }, "PageCommentMark"],
  parseInline: [
    {
      name: "PageComment",
      before: "Escape",
      parse(cx, next, pos) {
        if (next !== percent || cx.char(pos + 1) !== percent) return -1;
        const close = cx.text.indexOf("%%", pos + 2 - cx.offset);
        if (close < 0) return -1;
        const end = close + cx.offset + 2;
        return cx.addElement(
          cx.elt("PageComment", pos, end, [
            cx.elt("PageCommentMark", pos, pos + 2),
            cx.elt("PageCommentMark", end - 2, end),
          ]),
        );
      },
    },
  ],
  parseBlock: [
    {
      name: "PageCommentBlock",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line) {
        if (!opensComment(line.text, line.pos)) return false;
        const start = cx.lineStart + line.pos;
        const marks = [cx.elt("PageCommentMark", start, start + 2)];
        // The opening line closes the comment itself when it ends in a second `%%`.
        let closed = closesComment(line.text, line.pos + 2);
        while (!closed && cx.nextLine()) closed = closesComment(line.text, line.pos);
        if (!closed) {
          cx.addElement(cx.elt("PageCommentBlock", start, cx.prevLineEnd(), marks));
          return true;
        }
        const end = cx.lineStart + line.text.trimEnd().length;
        marks.push(cx.elt("PageCommentMark", end - 2, end));
        cx.addElement(cx.elt("PageCommentBlock", start, end, marks));
        cx.nextLine();
        return true;
      },
    },
  ],
};

/** A letter, digit or `_`, the characters a tag cannot follow. */
const wordChar = /[\p{L}\p{N}_]/u;
/** The characters of a tag's name: letters, digits, `_`, `-` and `/`. */
const tagChar = /[\p{L}\p{N}_/-]/u;

/** Tags: `#` and a name that is not only digits, not inside a word, by Obsidian's rule. */
const tags: MarkdownConfig = {
  defineNodes: ["Tag"],
  parseInline: [
    {
      name: "Tag",
      parse(cx, next, pos) {
        if (next !== hash || wordChar.test(cx.slice(pos - 1, pos))) return -1;
        let end = pos + 1;
        while (end < cx.end && tagChar.test(cx.slice(end, end + 1))) end++;
        const name = cx.slice(pos + 1, end);
        if (name === "" || /^\d+$/.test(name)) return -1;
        return cx.addElement(cx.elt("Tag", pos, end));
      },
    },
  ],
};

/** Block ids: whitespace, `^` and letters, digits or `-` at the end of a line. */
const blockIds: MarkdownConfig = {
  defineNodes: ["BlockId"],
  parseInline: [
    {
      name: "BlockId",
      parse(cx, next, pos) {
        if (next !== caret || !/^[ \t]$/.test(cx.slice(pos - 1, pos))) return -1;
        let end = pos + 1;
        while (end < cx.end && /[A-Za-z0-9-]/.test(cx.slice(end, end + 1))) end++;
        if (end === pos + 1) return -1;
        let after = end;
        while (after < cx.end && /[ \t]/.test(cx.slice(after, after + 1))) after++;
        if (after < cx.end && cx.char(after) !== newline) return -1;
        return cx.addElement(cx.elt("BlockId", pos, end));
      },
    },
  ],
};

/**
 * The extensions the editor's Markdown language adds to the CommonMark base: GFM, then wiki links
 * and embeds, highlights, comments, tags and block ids. Not `markdownLanguage`, whose subscript,
 * superscript and emoji syntax pages do not have.
 */
export const pageSyntax: MarkdownExtension = [GFM, wikiLinks, highlights, comments, tags, blockIds];
