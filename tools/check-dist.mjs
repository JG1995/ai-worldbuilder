// Fails when the production build is missing or contains the browser preview's sample data.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The sample version in src/lib/preview-fixtures.ts. It is fixture data that the preview
// reads at runtime, so it is in any bundle that includes the fixtures.
const PREVIEW_MARKER = "0.0.0-preview.sample-data";
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

/** @type {import("node:fs").Dirent[]} */
let entries;
try {
  entries = await readdir(distDir, { recursive: true, withFileTypes: true });
} catch {
  console.error("dist/ is missing. Run `pnpm build` first.");
  process.exit(1);
}

const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
/** @type {string[]} */
const offenders = [];
for (const file of files) {
  const contents = await readFile(file, "utf8");
  if (contents.includes(PREVIEW_MARKER)) offenders.push(relative(distDir, file));
}

if (offenders.length > 0) {
  console.error(`Preview sample data found in the production build: ${offenders.join(", ")}`);
  process.exit(1);
}
console.log(`dist/ has no preview sample data (${files.length} files checked).`);
