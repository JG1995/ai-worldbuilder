// An in-memory sample world for the browser preview (`pnpm dev`). Development builds only:
// `ipc.ts` loads this module behind `import.meta.env.DEV`, and `tools/check-dist.mjs` fails the
// check if the marker below, which every version token carries, appears in a production bundle.
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { PageText, WorldOpened } from "../features/world/commands";
import type { TreeEntry } from "../ui/FileTree";

const previewMarker = "0.0.0-preview.sample-data";

/** A page's text, or `notUtf8` for a page whose bytes the core would refuse to decode. */
type SamplePage = string | { notUtf8: true };

const samplePages: Record<string, SamplePage> = {
  "Campaign overview.md": `---
title: The Glass Steppe
system: homebrew
tags: [overview, players]
---

# The Glass Steppe

A plain of fused sand where the old war ended. Caravans cross it by night, when the glass is cool.

## Travel rules

Each night of travel costs one water ration per rider. Roll on the table below for weather:

\`\`\`text
1-2  still air, clear stars
3-4  singing wind (no rests)
5-6  glass storm (shelter or take 2d6)
\`\`\`

Use \`inline code\` for dice notation such as \`3d6\`.
`,
  "Characters/Brother Ketil.md": "# Brother Ketil\n\nKeeper of the shrine at Kesh Tor.\n",
  "Characters/Captain Orlaith Venn.md":
    "# Captain Orlaith Venn\n\nLeads the last caravan that still crosses in summer.\n",
  "Characters/The salt merchant.md": "# The salt merchant\n\nNobody knows her name.\n",
  "Factions/Glasswrights' Guild.md": "# Glasswrights' Guild\n\nThey mine the steppe for lenses.\n",
  "Factions/Riders of the Dun Sky.md": "# Riders of the Dun Sky\n\nNomads who never camp twice.\n",
  "Locations/Kesh Tor.md": "# Kesh Tor\n\nA basalt spire, the only shade for a day's ride.\n",
  "Locations/Locked chronicle.md":
    "# Locked chronicle\n\nIn the preview, another program holds this page open, so saving it always fails.\n",
  "Locations/Old trade ledger.md": { notUtf8: true },
  "Locations/The mirror lake.md": "# The mirror lake\n\nIts surface shows the sky of last night.\n",
  "Session notes/Session 1.md": "# Session 1\n\nThe party joins Venn's caravan.\n",
  "Session notes/Session 2.md": "# Session 2\n\nA glass storm strands the caravan at Kesh Tor.\n",
  "Session notes/Session 10.md": "# Session 10\n\nThe Guild's lens finally works.\n",
};

/** The page whose saves always fail, so the failed-save notice and dialog can be seen. */
const lockedPage = "Locations/Locked chronicle.md";

/** How often each page has been saved in this preview session; its version names the count. */
const saves: Record<string, number> = {};

const versionOf = (path: string) => `${previewMarker}:${path}:${(saves[path] ?? 0) + 1}`;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The tree of `paths`, folders first and then by name, as the core sorts it. */
function treeOf(paths: string[]): TreeEntry[] {
  const root: TreeEntry[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    let level = root;
    segments.forEach((segment, index) => {
      const entryPath = segments.slice(0, index + 1).join("/");
      if (index === segments.length - 1) {
        level.push({ path: entryPath, name: segment.replace(/\.md$/i, ""), kind: "page" });
        return;
      }
      let folder = level.find((entry) => entry.path === entryPath);
      if (!folder) {
        folder = { path: entryPath, name: segment, kind: "folder", children: [] };
        level.push(folder);
      }
      level = folder.children ?? [];
    });
  }
  const sort = (entries: TreeEntry[]): TreeEntry[] =>
    entries
      .map((entry) => (entry.children ? { ...entry, children: sort(entry.children) } : entry))
      .sort(
        (a, b) =>
          Number(a.kind === "page") - Number(b.kind === "page") || byName.compare(a.name, b.name),
      );
  return sort(root);
}

let open = false;
let session = 0;

function requireWorld() {
  if (!open) throw { kind: "no_world", message: "No world is open." };
}

/** The text of the page at `args.path`, throwing like the core for a missing or non-UTF-8 page. */
function pageText(args: InvokeArgs | undefined) {
  requireWorld();
  const path = String((args as { path?: unknown } | undefined)?.path);
  const page = samplePages[path];
  if (page === undefined) {
    throw { kind: "not_found", message: "The page or folder does not exist." };
  }
  if (typeof page !== "string") {
    throw {
      kind: "not_utf8",
      message: "The page is not UTF-8 text, so it cannot be edited here. It has not been changed.",
    };
  }
  return { path, text: page };
}

/** Sample command results: values, or functions of the arguments that throw like the core. */
export const previewFixtures: Record<string, unknown> = {
  // Opens the sample world at once: the preview has no folder dialog.
  world_open: (): WorldOpened => {
    open = true;
    session += 1;
    return {
      name: "The Glass Steppe",
      session,
      workspace: { tabs: [], active: null, expanded: [], treeWidth: 264 },
    };
  },
  world_close: () => {
    open = false;
    return null;
  },
  world_tree: (): TreeEntry[] => {
    requireWorld();
    return treeOf(Object.keys(samplePages));
  },
  page_read: (args?: InvokeArgs): PageText => {
    const { path, text } = pageText(args);
    return { text, version: versionOf(path) };
  },
  // Keeps saved text for as long as the preview page stays loaded.
  page_write: (args?: InvokeArgs): { version: string } => {
    const { path, text } = pageText(args);
    const { text: edited, version } = args as { text: string; version: string };
    if (version !== versionOf(path)) {
      throw {
        kind: "conflict",
        message: "The page changed on disk since it was last read or saved.",
      };
    }
    if (path === lockedPage) throw { kind: "io", message: "Another program is using the file." };
    if (edited !== text) {
      samplePages[path] = edited;
      saves[path] = (saves[path] ?? 0) + 1;
    }
    return { version: versionOf(path) };
  },
};
