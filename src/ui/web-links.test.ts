import { describe, expect, it } from "vitest";
import { createPageState } from "./MarkdownEditor";
import { webLinkAt } from "./web-links";

/** The web link at the first character of `part` in a page of `text`. */
function webLinkIn(text: string, part: string) {
  const state = createPageState(text, "Kesh Tor", 0, { preview: true });
  return webLinkAt(state, text.indexOf(part));
}

describe("webLinkAt", () => {
  it.each([
    ["[the docks](https://docks.example/map)", "the", "https://docks.example/map"],
    ['[the docks](https://docks.example "Docks")', "docks]", "https://docks.example"],
    ["[the docks](<https://docks.example/a>)", "the", "https://docks.example/a"],
    ["[the docks](https://docks.example/a\\_b)", "the", "https://docks.example/a_b"],
    ["[](http://docks.example)", "[", "http://docks.example"],
    ["<https://tide.example/sea>", "tide", "https://tide.example/sea"],
    ["Sail to https://tide.example/sea.", "tide", "https://tide.example/sea"],
    ["Sail to www.tide.example now", "tide", "http://www.tide.example"],
    // A bare address in a link's text belongs to the link.
    ["[see https://a.example](https://b.example)", "a.example", "https://b.example"],
  ])("finds the web link in %s", (text, part, address) => {
    expect(webLinkIn(text, part)?.address).toBe(address);
  });

  it("finds a link from either of its ends, and gives its range", () => {
    const text = "See [docks](https://docks.example) now";
    const state = createPageState(text, "Kesh Tor", 0, { preview: true });
    const link = { from: text.indexOf("["), to: text.indexOf(" now") };

    expect(webLinkAt(state, link.from)).toEqual({ ...link, address: "https://docks.example" });
    expect(webLinkAt(state, link.to)).toEqual({ ...link, address: "https://docks.example" });
    expect(webLinkAt(state, link.from - 1)).toBeNull();
    expect(webLinkAt(state, link.to + 1)).toBeNull();
  });

  it("finds the link that starts where another ends", () => {
    const text = "<https://a.example><https://b.example>";
    const state = createPageState(text, "Kesh Tor", 0, { preview: true });

    expect(webLinkAt(state, text.indexOf("<https://b"))?.address).toBe("https://b.example");
  });

  it.each([
    ["[mail](mailto:a@b.example)", "mail"],
    ["<mailto:a@b.example>", "mailto"],
    ["Write to a@b.example", "a@b"],
    ["[file](file:///etc/passwd)", "file"],
    ["[run](javascript:alert(1))", "run"],
    ["[data](data:text/html,x)", "data"],
    ["[ftp](ftp://x.example)", "ftp"],
    ["[page](Docks.md)", "page"],
    ["[no host](https://)", "no host"],
    ["[spaced](<https://docks.example/a b>)", "spaced"],
    ["[ref][docks]\n\n[docks]: https://docks.example", "ref"],
    ["![map](https://docks.example/map.png)", "map"],
    ["Roll `https://docks.example` now", "https"],
    ["```\nhttps://docks.example\n```", "https"],
    ["---\nsource: https://docks.example\n---\nText", "https"],
  ])("finds no web link in %s", (text, part) => {
    expect(webLinkIn(text, part)).toBeNull();
  });
});
