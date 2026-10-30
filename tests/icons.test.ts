import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fontSha256, glyphs } from "../src/ui/icon-glyphs";

const root = join(import.meta.dirname, "..");
const names: string[] = JSON.parse(readFileSync(join(root, "src/ui/icon-names.json"), "utf8"));

it("generates a glyph for exactly the listed icon names", () => {
  expect(Object.keys(glyphs).sort()).toEqual([...names].sort());
});

it("records the SHA-256 of the committed icon font", () => {
  const font = readFileSync(join(root, "src/assets/icons/material-symbols-sharp.woff2"));
  expect(createHash("sha256").update(font).digest("hex")).toBe(fontSha256);
});

it("bundles no sparkle or magic glyph", () => {
  expect(names.filter((name) => /awesome|magic|sparkle/.test(name))).toEqual([]);
});
