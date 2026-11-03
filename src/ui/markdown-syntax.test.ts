import { markdown } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { pageSyntax } from "./markdown-syntax";

const { parser } = markdown({ extensions: pageSyntax }).language;

/** Each node of `text`'s tree as its name and the text it covers, in document order. */
function nodes(text: string) {
  const found: [string, string][] = [];
  parser.parse(text).iterate({
    enter: (node) => {
      if (node.name !== "Document") found.push([node.name, text.slice(node.from, node.to)]);
    },
  });
  return found;
}

function names(text: string) {
  return nodes(text).map(([name]) => name);
}

describe("the page syntax", () => {
  it.each([
    ["[[Saltmere]]", "WikiLink"],
    ["![[Saltmere]]", "WikiEmbed"],
    ["[[A|B]]", "WikiLink"],
    ["[[Kesh Tor#Shelter]]", "WikiLink"],
  ])("reads %s as one wiki node, never a Markdown link or image", (link, node) => {
    const found = nodes(`See ${link} now.`);

    expect(found).toContainEqual([node, link]);
    expect(found.filter(([name]) => name === "WikiLinkMark").map(([, text]) => text)).toEqual([
      link.startsWith("!") ? "![[" : "[[",
      "]]",
    ]);
    expect(names(`See ${link} now.`)).not.toContain("Link");
    expect(names(`See ${link} now.`)).not.toContain("Image");
  });

  it("leaves a wiki link that spans lines, and empty brackets, as text", () => {
    expect(names("[[Salt\nmere]] and [[]]")).not.toContain("WikiLink");
  });

  it("reads ==text== as a highlight with its marks", () => {
    expect(nodes("A ==tide== rises")).toEqual([
      ["Paragraph", "A ==tide== rises"],
      ["Highlight", "==tide=="],
      ["HighlightMark", "=="],
      ["HighlightMark", "=="],
    ]);
  });

  it("reads %%…%% as a comment, inline and as a block, and parses nothing inside it", () => {
    expect(nodes("Ash %%[[Saltmere]] *x*%% fell")).toEqual([
      ["Paragraph", "Ash %%[[Saltmere]] *x*%% fell"],
      ["PageComment", "%%[[Saltmere]] *x*%%"],
      ["PageCommentMark", "%%"],
      ["PageCommentMark", "%%"],
    ]);
    expect(nodes("%%\n# secret\n%%\nAfter")).toEqual([
      ["PageCommentBlock", "%%\n# secret\n%%"],
      ["PageCommentMark", "%%"],
      ["PageCommentMark", "%%"],
      ["Paragraph", "After"],
    ]);
  });

  it("reads a line that starts with an inline comment as a paragraph, not a comment block", () => {
    expect(nodes("%%a%% text\n# After")).toEqual([
      ["Paragraph", "%%a%% text"],
      ["PageComment", "%%a%%"],
      ["PageCommentMark", "%%"],
      ["PageCommentMark", "%%"],
      ["ATXHeading1", "# After"],
      ["HeaderMark", "#"],
    ]);
  });

  it("ends a comment block on the first later line that holds %%, with that line's rest inside it", () => {
    expect(nodes("%%\nx\n%% after\n# After")).toEqual([
      ["PageCommentBlock", "%%\nx\n%% after"],
      ["PageCommentMark", "%%"],
      ["PageCommentMark", "%%"],
      ["ATXHeading1", "# After"],
      ["HeaderMark", "#"],
    ]);
    expect(nodes("%%\nx %% y\n# After")).toContainEqual(["ATXHeading1", "# After"]);
  });

  it.each(["#lore", "#lore/ruins-2", "#Ünter_1"])("reads %s as a tag", (tag) => {
    expect(nodes(`${tag} here`)).toContainEqual(["Tag", tag]);
  });

  it.each(["#12", "word#lore", "# Heading"])("does not read %s as a tag", (text) => {
    expect(names(text)).not.toContain("Tag");
  });

  it("reads a ^id at a line's end as a block id, and not elsewhere", () => {
    expect(nodes("The bell tolls ^bell-1\nNext")).toContainEqual(["BlockId", "^bell-1"]);
    expect(names("The ^bell tolls")).not.toContain("BlockId");
    expect(names("The bell^tolls")).not.toContain("BlockId");
  });

  it("parses GFM's task, strikethrough and table", () => {
    const found = names("- [x] ~~done~~\n\n| A | B |\n| - | - |\n| 1 | 2 |");

    expect(found).toEqual(expect.arrayContaining(["Task", "TaskMarker", "Strikethrough", "Table"]));
  });

  it.each(["^sup^", "~sub~", ":emoji:"])("leaves %s as text", (text) => {
    expect(names(`A ${text} b`)).toEqual(["Paragraph"]);
  });
});
