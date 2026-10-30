import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The colour roles in .wiki/DESIGN.md's frontmatter, then the dialog backdrop from its Dialogs
// section and the input fill alias from its Inputs section. CI cannot read .wiki/, so these
// tables are the copy the stylesheet is checked against; update both together.
const designColours = {
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
  success: { dark: "#3fc6a0", light: "#08795e" },
  warning: { dark: "#e59b37", light: "#8f5a06" },
  error: { dark: "#fe8477", light: "#b4312b" },
  info: { dark: "#66b2fd", light: "#196aaf" },
  "on-status": { dark: "#091016", light: "#ffffff" },
  "diff-added": { dark: "#073025", light: "#d6f8eb" },
  "diff-removed": { dark: "#471713", light: "#ffe9e6" },
  backdrop: { dark: "rgba(0, 0, 0, 0.5)", light: "rgba(19, 29, 36, 0.3)" },
  input: { dark: "var(--color-raised)", light: "var(--color-page)" },
};

// The level 2 shadow from DESIGN.md's Elevation & Depth section.
const level2Shadow = {
  dark: "0 8px 24px rgba(0, 0, 0, 0.5)",
  light: "0 8px 24px rgba(19, 29, 36, 0.12)",
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

function colourTokens(block: string) {
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

function expected(mode: "dark" | "light") {
  return Object.fromEntries(
    Object.entries(designColours).map(([name, values]) => [name, values[mode]]),
  );
}

describe("theme.css", () => {
  it("defines every DESIGN.md colour role with its dark value as the default", () => {
    expect(colourTokens(blockAfter(theme, "@theme static"))).toEqual(expected("dark"));
  });

  it("overrides every colour role with its DESIGN.md light value in light mode", () => {
    expect(colourTokens(blockAfter(theme, "@variant light"))).toEqual(expected("light"));
  });

  it("defines the DESIGN.md level 2 shadow in both modes", () => {
    const shadow = (block: string) => block.match(/--level-2-shadow:\s*([^;]+);/)?.[1];
    expect(shadow(blockAfter(theme, "@theme static"))).toBe(level2Shadow.dark);
    expect(shadow(blockAfter(theme, "@variant light"))).toBe(level2Shadow.light);
  });
});

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
