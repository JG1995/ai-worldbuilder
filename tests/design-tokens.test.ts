import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type Modes = { dark: string; light: string };

// Each theme's colour roles from its document's frontmatter, then the dialog backdrop from its
// Dialogs section, the input fill alias from its Inputs section and the level 2 shadow from its
// Elevation & Depth section. Saturn Seal's document is .wiki/DESIGN.md. CI cannot read .wiki/,
// so these tables are the copy the stylesheet is checked against; update both together.
const themes: Record<string, { colours: Record<string, Modes>; level2Shadow: Modes }> = {
  "saturn-seal": {
    colours: {
      window: { dark: "#091016", light: "#f1f3f5" },
      page: { dark: "#131d24", light: "#ffffff" },
      raised: { dark: "#232d34", light: "#ffffff" },
      hover: { dark: "#232d34", light: "#e4e7e9" },
      selected: { dark: "#30383e", light: "#dde1e4" },
      divider: { dark: "#38434b", light: "#e4e7e9" },
      outline: { dark: "#7e8991", light: "#6b747c" },
      text: { dark: "#f1f3f5", light: "#131d24" },
      "text-muted": { dark: "#9ba3a8", light: "#4d575e" },
      "text-disabled": { dark: "#6b747c", light: "#9ba3a8" },
      accent: { dark: "#9edfe0", light: "#487374" },
      "accent-hover": { dark: "#c1edee", light: "#395f5f" },
      "on-accent": { dark: "#091016", light: "#ffffff" },
      selection: { dark: "#2e4f4f", light: "#dff6f6" },
      highlight: { dark: "#553a10", light: "#f8dcae" },
      success: { dark: "#3fc6a0", light: "#08795e" },
      warning: { dark: "#e59b37", light: "#8f5a06" },
      error: { dark: "#fe8477", light: "#b4312b" },
      info: { dark: "#66b2fd", light: "#196aaf" },
      "on-status": { dark: "#091016", light: "#ffffff" },
      "diff-added": { dark: "#073025", light: "#d6f8eb" },
      "diff-removed": { dark: "#471713", light: "#ffe9e6" },
      backdrop: { dark: "rgba(0, 0, 0, 0.5)", light: "rgba(19, 29, 36, 0.3)" },
      input: { dark: "var(--color-raised)", light: "var(--color-page)" },
    },
    level2Shadow: {
      dark: "0 8px 24px rgba(0, 0, 0, 0.5)",
      light: "0 8px 24px rgba(19, 29, 36, 0.12)",
    },
  },
  // .wiki/DESIGN-BOUND.md: its frontmatter, including the title strap's seal, then its Other values
  // table.
  bound: {
    colours: {
      window: { dark: "#160d0b", light: "#f3eee4" },
      page: { dark: "#241816", light: "#fcfaf9" },
      raised: { dark: "#342826", light: "#ffffff" },
      hover: { dark: "#342826", light: "#e9e5e4" },
      selected: { dark: "#3a3630", light: "#e6dccb" },
      divider: { dark: "#4b3d3b", light: "#e9e5e4" },
      outline: { dark: "#a29885", light: "#7c706e" },
      text: { dark: "#f5f2f2", light: "#241816" },
      "text-muted": { dark: "#a99f9d", light: "#5f5250" },
      "text-disabled": { dark: "#7c706e", light: "#a99f9d" },
      accent: { dark: "#e6dccb", light: "#59544a" },
      "accent-hover": { dark: "#f3eee4", light: "#4a463e" },
      "on-accent": { dark: "#160d0b", light: "#ffffff" },
      selection: { dark: "#59544a", light: "#d8d3d2" },
      highlight: { dark: "#553a10", light: "#f8dcae" },
      success: { dark: "#3fc6a0", light: "#08795e" },
      warning: { dark: "#e59b37", light: "#8f5a06" },
      error: { dark: "#fe818c", light: "#b23046" },
      info: { dark: "#66b2fd", light: "#196aaf" },
      "on-status": { dark: "#160d0b", light: "#ffffff" },
      "diff-added": { dark: "#073025", light: "#d6f8eb" },
      "diff-removed": { dark: "#47151c", light: "#ffe9e9" },
      seal: { dark: "#e57163", light: "#7d1a14" },
      backdrop: { dark: "rgba(0, 0, 0, 0.5)", light: "rgba(36, 24, 22, 0.3)" },
      input: { dark: "var(--color-raised)", light: "var(--color-page)" },
    },
    level2Shadow: {
      dark: "0 8px 24px rgba(0, 0, 0, 0.5)",
      light: "0 8px 24px rgba(36, 24, 22, 0.12)",
    },
  },
  // .wiki/DESIGN-LAMPLIGHT.md: its frontmatter, then its Other values table.
  lamplight: {
    colours: {
      window: { dark: "#03130f", light: "#f0f4f3" },
      page: { dark: "#13231f", light: "#ffffff" },
      raised: { dark: "#1b302b", light: "#ffffff" },
      hover: { dark: "#1b302b", light: "#e2e8e6" },
      selected: { dark: "#293b37", light: "#cce3dd" },
      divider: { dark: "#304641", light: "#e2e8e6" },
      outline: { dark: "#849b94", light: "#657873" },
      text: { dark: "#f0f4f3", light: "#0a201b" },
      "text-muted": { dark: "#96a5a1", light: "#465a55" },
      "text-disabled": { dark: "#657873", light: "#96a5a1" },
      accent: { dark: "#f2dc93", light: "#6b4d2f" },
      "accent-hover": { dark: "#f6efc9", light: "#5b4027" },
      "on-accent": { dark: "#03130f", light: "#ffffff" },
      selection: { dark: "#3e524c", light: "#e0f3ee" },
      highlight: { dark: "#5b4027", light: "#f2dc93" },
      success: { dark: "#3fc6a0", light: "#08795e" },
      warning: { dark: "#f29237", light: "#975306" },
      error: { dark: "#fe8477", light: "#b4312b" },
      info: { dark: "#66b2fd", light: "#196aaf" },
      "on-status": { dark: "#03130f", light: "#ffffff" },
      "diff-added": { dark: "#073025", light: "#d6f8eb" },
      "diff-removed": { dark: "#471713", light: "#ffe9e6" },
      backdrop: { dark: "rgba(0, 0, 0, 0.5)", light: "rgba(10, 32, 27, 0.3)" },
      input: { dark: "var(--color-raised)", light: "var(--color-page)" },
    },
    level2Shadow: {
      dark: "0 8px 24px rgba(0, 0, 0, 0.5)",
      light: "0 8px 24px rgba(10, 32, 27, 0.12)",
    },
  },
};

const srcDir = join(import.meta.dirname, "../src");
const themePath = join(srcDir, "ui/theme.css");
const theme = readFileSync(themePath, "utf8");

/** The body of the first `{ … }` block after `marker`. */
function blockAfter(css: string, marker: string) {
  const start = css.indexOf("{", css.indexOf(marker));
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start + 1, i);
  }
  throw new Error(`No block after ${marker}`);
}

/** `block` without the declarations of the blocks nested in it. */
function ownDeclarations(block: string) {
  let depth = 0;
  let own = "";
  for (const char of block) {
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (depth === 0) own += char;
  }
  return own;
}

/**
 * A theme's dark and light blocks. Saturn Seal's dark values are the defaults in `@theme static`
 * and its light values sit in `:root`; every other theme's dark values sit in its own root rule,
 * beside its nested light block.
 */
function themeBlocks(id: string) {
  const root = blockAfter(theme, id === "saturn-seal" ? ":root {" : `:root[data-theme="${id}"]`);
  return {
    dark: id === "saturn-seal" ? blockAfter(theme, "@theme static") : ownDeclarations(root),
    light: blockAfter(root, "@variant light"),
  };
}

function colourTokens(block: string) {
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

function expected(colours: Record<string, Modes>, mode: keyof Modes) {
  return Object.fromEntries(Object.entries(colours).map(([name, values]) => [name, values[mode]]));
}

const shadow = (block: string) => block.match(/--level-2-shadow:\s*([^;]+);/)?.[1];

for (const [id, { colours, level2Shadow }] of Object.entries(themes)) {
  describe(`theme.css, ${id}`, () => {
    const blocks = themeBlocks(id);

    it("defines every colour role with its dark value", () => {
      expect(colourTokens(blocks.dark)).toEqual(expected(colours, "dark"));
    });

    it("overrides every colour role with its light value in light mode", () => {
      expect(colourTokens(blocks.light)).toEqual(expected(colours, "light"));
    });

    it("defines the level 2 shadow in both modes", () => {
      expect(shadow(blocks.dark)).toBe(level2Shadow.dark);
      expect(shadow(blocks.light)).toBe(level2Shadow.light);
    });
  });
}

describe("source files other than theme.css", () => {
  const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx|css)$/.test(file))
    .map((file) => join(srcDir, file))
    .filter((file) => file !== themePath);

  it.each(sources.map((file) => [relative(srcDir, file), file]))(
    "%s has no colour literal and sets no style attribute or element",
    (_name, file) => {
      const contents = readFileSync(file, "utf8");
      expect(contents).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/);
      expect(contents).not.toMatch(/setAttribute\(\s*["']style["']/);
      expect(contents).not.toMatch(/<style[\s>]/);
    },
  );
});
