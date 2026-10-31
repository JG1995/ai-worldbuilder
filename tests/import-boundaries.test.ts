import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The layers of src/, after Bulletproof React. Shared code (ui, lib, types, assets, test) imports
// only shared code. A feature imports shared code and itself, never another feature. The app layer
// (app/ and the entry files at the top of src/) may import any feature. The showcase shows shared
// components only, and nothing outside it imports it.

type Layer = "shared" | "feature" | "app" | "showcase";

const srcDir = join(import.meta.dirname, "../src");

/** `features/<name>`, another top-level folder of src/, or `entry` for a file at the top of src/. */
function areaOf(file: string) {
  const [first, second] = relative(srcDir, file).split(/[\\/]/);
  if (second === undefined) return "entry";
  return first === "features" ? `features/${second}` : first;
}

function layerOf(area: string): Layer {
  if (area.startsWith("features/")) return "feature";
  if (area === "app" || area === "entry") return "app";
  if (area === "showcase") return "showcase";
  return "shared";
}

function mayImport(from: string, to: string) {
  if (from === to) return true;
  const target = layerOf(to);
  return layerOf(from) === "app" ? target !== "showcase" : target === "shared";
}

/** Static, side-effect and dynamic imports of a path inside src/. */
const importPattern = /(?:from|import)\s*\(?\s*["']((?:\.|@\/)[^"']*)["']/g;

const imports = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file))
  .flatMap((file) => {
    const path = join(srcDir, file);
    return [...readFileSync(path, "utf8").matchAll(importPattern)].map(([, specifier]) => {
      const target = specifier.startsWith("@/")
        ? join(srcDir, specifier.slice(2))
        : resolve(dirname(path), specifier);
      return { file, specifier, from: areaOf(path), to: areaOf(target) };
    });
  });

describe("imports in src/", () => {
  it("cross from one area to another only as their layers allow", () => {
    expect(imports.length).toBeGreaterThan(0);
    const crossings = imports
      .filter(({ from, to }) => !mayImport(from, to))
      .map(({ file, specifier, from, to }) => `${file} imports ${specifier} (${from} → ${to})`);
    expect(crossings).toEqual([]);
  });

  it("use @/ to leave their area and a relative path inside it", () => {
    const misspelled = imports
      .filter(({ specifier, from, to }) => specifier.startsWith("@/") === (from === to))
      .map(({ file, specifier }) => `${file} imports ${specifier}`);
    expect(misspelled).toEqual([]);
  });
});
