// Fails when the production build is missing, contains the browser preview's sample data or the
// showcase page, or inlines a font or image as a data: URL, which the production CSP blocks.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The marker in every version token of src/lib/preview-fixtures.ts's sample world. It is data
// that the preview returns at runtime, so it is in any bundle that includes the fixtures.
const PREVIEW_MARKER = "0.0.0-preview.sample-data";
const INLINED_ASSET = /data:font\/|data:application\/font|data:image\/|url\(\s*["']?data:/;
// The one exemption: the tab-arrow image of `.cm-highlightTab` in @codemirror/view's base theme,
// exactly as the bundle has it. The editor does not highlight tabs, so it is never requested.
const CODEMIRROR_TAB_IMAGE = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20"><path stroke="%23888" stroke-width="1" fill="none" d="M1 10H196L190 5M190 15L196 10M197 4L197 16"/></svg>')`;
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
/** @type {string[]} */
const inlined = [];
for (const file of files) {
  const contents = await readFile(file, "utf8");
  if (contents.includes(PREVIEW_MARKER)) offenders.push(relative(distDir, file));
  const withoutExemption = contents.replaceAll(CODEMIRROR_TAB_IMAGE, "");
  if (INLINED_ASSET.test(withoutExemption)) inlined.push(relative(distDir, file));
}
const showcase = files.filter((file) => file.endsWith("showcase.html"));

if (offenders.length > 0) {
  console.error(`Preview sample data found in the production build: ${offenders.join(", ")}`);
  process.exit(1);
}
if (showcase.length > 0) {
  console.error(`The showcase page is in the production build: ${showcase.join(", ")}`);
  process.exit(1);
}
if (inlined.length > 0) {
  console.error(
    `Fonts or images inlined as data: URLs in the production build: ${inlined.join(", ")}`,
  );
  process.exit(1);
}
console.log(
  `dist/ has no preview sample data, showcase or inlined assets (${files.length} files checked).`,
);
