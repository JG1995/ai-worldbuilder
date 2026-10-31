// An in-memory sample world for the browser preview (`pnpm dev`). Development builds only:
// `ipc.ts` loads this module behind `import.meta.env.DEV`, and `tools/check-dist.mjs` fails the
// check if the marker below, which every version token carries, appears in a production bundle.
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { DiffLine, PageText, WorldOpened } from "../features/world/commands";
import type { TreeEntry } from "../ui/FileTree";
import type { RecentWorld } from "../ui/WelcomeScreen";

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

/** A preview world: its pages, the folders created in it, and how often each page was saved. */
type PreviewWorld = {
  name: string;
  pages: Record<string, SamplePage>;
  folders: Set<string>;
  saves: Record<string, number>;
};

const emptyWorld = (name: string): PreviewWorld => ({
  name,
  pages: {},
  folders: new Set(),
  saves: {},
});

const sampleWorld: PreviewWorld = { ...emptyWorld("The Glass Steppe"), pages: samplePages };

const versionOf = (world: PreviewWorld, path: string) =>
  `${previewMarker}:${path}:${(world.saves[path] ?? 0) + 1}`;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The tree of a world's pages and folders, folders first and then by name, as the core sorts it. */
function treeOf(world: PreviewWorld): TreeEntry[] {
  const root: TreeEntry[] = [];
  const add = (path: string, kind: TreeEntry["kind"]) => {
    const segments = path.split("/");
    let level = root;
    segments.forEach((segment, index) => {
      const entryPath = segments.slice(0, index + 1).join("/");
      if (index === segments.length - 1 && kind === "page") {
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
  };
  for (const folder of world.folders) add(folder, "folder");
  for (const page of Object.keys(world.pages)) add(page, "page");
  const sort = (entries: TreeEntry[]): TreeEntry[] =>
    entries
      .map((entry) => (entry.children ? { ...entry, children: sort(entry.children) } : entry))
      .sort(
        (a, b) =>
          Number(a.kind === "page") - Number(b.kind === "page") || byName.compare(a.name, b.name),
      );
  return sort(root);
}

/** The names of the entries directly in `folder`, or at the top level when it is null. */
function namesIn(world: PreviewWorld, folder: string | null) {
  const prefix = folder === null ? "" : `${folder}/`;
  return [...Object.keys(world.pages), ...world.folders]
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).split("/")[0]);
}

const forbiddenCharacters = /[/\\:*?"<>|\p{Cc}]/u;

/**
 * A short copy of the core's naming rules (`src-tauri/src/world/names.rs`), enough to show their
 * errors in the preview. The core is the authority.
 */
function checkName(name: string) {
  const rule =
    name === ""
      ? "Names cannot be empty."
      : name.startsWith(".")
        ? "Names cannot start with a dot."
        : name.startsWith(" ") || name.endsWith(" ")
          ? "Names cannot start or end with a space."
          : name.endsWith(".")
            ? "Names cannot end with a dot."
            : forbiddenCharacters.test(name)
              ? 'Names cannot contain / \\ : * ? " < > | or control characters, which some systems forbid.'
              : /[[\]#^]/.test(name)
                ? "Names cannot contain [ ] # or ^, which break wiki links."
                : /^(con|prn|aux|nul|com[1-9]|lpt[1-9]) *$/i.test(name.split(".")[0])
                  ? "Windows reserves CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9, even with an extension."
                  : null;
  if (rule) throw { kind: "invalid_name", message: rule };
}

function checkFree(names: string[], fileName: string) {
  if (names.some((name) => name.toLowerCase() === fileName.toLowerCase())) {
    throw {
      kind: "exists",
      message: "Something with this name already exists here. Letter case does not count.",
    };
  }
}

let world: PreviewWorld | null = null;
let session = 0;

/** A recent world of the preview and the preview world it opens, or none for a missing folder. */
type PreviewRecent = RecentWorld & { world: PreviewWorld | null };

const sampleWorldPath = "/home/preview/Worlds/The Glass Steppe";

/** The preview's recent worlds, most recently opened first. */
let recentWorlds: PreviewRecent[] = [
  {
    id: "1",
    name: sampleWorld.name,
    path: sampleWorldPath,
    missing: false,
    world: sampleWorld,
  },
  {
    id: "2",
    name: "Ashfall Reaches",
    path: "/home/preview/Worlds/Ashfall Reaches",
    missing: false,
    world: emptyWorld("Ashfall Reaches"),
  },
  {
    id: "3",
    name: "The Sunken Archive",
    path: "/media/preview/backup/Worlds/The Sunken Archive",
    missing: true,
    world: null,
  },
];
let nextRecentId = recentWorlds.length + 1;

/** Moves an opened world to the top of the recent list, adding it when it is new. */
function remember(opened: PreviewWorld, path: string) {
  const known = recentWorlds.find((recent) => recent.world === opened);
  const entry = known ?? {
    id: String(nextRecentId++),
    name: opened.name,
    path,
    missing: false,
    world: opened,
  };
  recentWorlds = [entry, ...recentWorlds.filter((recent) => recent !== entry)];
}

function requireWorld() {
  if (!world) throw { kind: "no_world", message: "No world is open." };
  return world;
}

function opened(next: PreviewWorld): WorldOpened {
  world = next;
  session += 1;
  return {
    name: next.name,
    session,
    workspace: { tabs: [], active: null, expanded: [], treeWidth: 264 },
  };
}

/** The text of the page at `args.path`, throwing like the core for a missing or non-UTF-8 page. */
function pageText(args: InvokeArgs | undefined) {
  const open = requireWorld();
  const path = String((args as { path?: unknown } | undefined)?.path);
  const page = open.pages[path];
  if (page === undefined) {
    throw { kind: "not_found", message: "The page or folder does not exist." };
  }
  if (typeof page !== "string") {
    throw {
      kind: "not_utf8",
      message: "The page is not UTF-8 text, so it cannot be edited here. It has not been changed.",
    };
  }
  return { open, path, text: page };
}

/** A text's lines, without the empty one after a final newline, as Rust's `str::lines` gives them. */
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * A line diff of `disk` against `text` from their longest common subsequence: enough for the
 * preview's short pages. The core uses `similar`.
 */
function compareLines(disk: string, text: string): DiffLine[] {
  const old = linesOf(disk);
  const mine = linesOf(text);
  // common[i][j]: the length of the longest common subsequence of old[i..] and mine[j..].
  const common = Array.from({ length: old.length + 1 }, () => Array(mine.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = mine.length - 1; j >= 0; j--) {
      common[i][j] =
        old[i] === mine[j]
          ? common[i + 1][j + 1] + 1
          : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length || j < mine.length) {
    if (i < old.length && j < mine.length && old[i] === mine[j]) {
      lines.push({ kind: "same", text: old[i++] });
      j++;
    } else if (j === mine.length || (i < old.length && common[i + 1][j] >= common[i][j + 1])) {
      lines.push({ kind: "removed", text: old[i++] });
    } else {
      lines.push({ kind: "added", text: mine[j++] });
    }
  }
  return lines;
}

/** Creates an empty page or folder like the core, refusing names that break a rule or clash. */
function createEntry(args: InvokeArgs | undefined, kind: TreeEntry["kind"]) {
  const open = requireWorld();
  const { folder, name } = args as { folder: string | null; name: string };
  const isFolder = (path: string) =>
    open.folders.has(path) || Object.keys(open.pages).some((page) => page.startsWith(`${path}/`));
  if (folder !== null && !isFolder(folder)) {
    throw { kind: "not_found", message: "The page or folder does not exist." };
  }
  checkName(name);
  const fileName = kind === "page" ? `${name}.md` : name;
  checkFree(namesIn(open, folder), fileName);
  const path = folder === null ? fileName : `${folder}/${fileName}`;
  if (kind === "page") open.pages[path] = "";
  else open.folders.add(path);
  return { path };
}

// The preview has no folder dialog: Browse… switches to the other sample location.
const previewLocations = ["/home/preview/Documents", "/home/preview/Campaigns"];
let newLocation = previewLocations[0];
/** The worlds created in each location this session, by name. */
const createdWorlds: Record<string, string[]> = {};

/** Sample command results: values, or functions of the arguments that throw like the core. */
export const previewFixtures: Record<string, unknown> = {
  // Opens the sample world at once: the preview has no folder dialog.
  world_open: (): WorldOpened => {
    remember(sampleWorld, sampleWorldPath);
    return opened(sampleWorld);
  },
  world_close: () => {
    world = null;
    return null;
  },
  world_tree: (): TreeEntry[] => treeOf(requireWorld()),
  page_read: (args?: InvokeArgs): PageText => {
    const { open, path, text } = pageText(args);
    return { text, version: versionOf(open, path) };
  },
  // Keeps saved text for as long as the preview page stays loaded.
  page_write: (args?: InvokeArgs): { version: string } => {
    const { open, path, text } = pageText(args);
    const { text: edited, version } = args as { text: string; version: string };
    if (version !== versionOf(open, path)) {
      throw {
        kind: "conflict",
        message: "The page changed on disk since it was last read or saved.",
      };
    }
    if (open === sampleWorld && path === lockedPage) {
      throw { kind: "io", message: "Another program is using the file." };
    }
    if (edited !== text) {
      open.pages[path] = edited;
      open.saves[path] = (open.saves[path] ?? 0) + 1;
    }
    return { version: versionOf(open, path) };
  },
  // The preview simulates no outside changes, so neither is reached from its pages; both answer
  // like the core.
  page_compare: (args?: InvokeArgs): { version: string; lines: DiffLine[] } => {
    const { open, path, text } = pageText(args);
    const { text: mine } = args as { text: string };
    return { version: versionOf(open, path), lines: compareLines(text, mine) };
  },
  page_restore: (args?: InvokeArgs): { version: string } => {
    const open = requireWorld();
    const { path, text } = args as { path: string; text: string };
    if (Object.hasOwn(open.pages, path)) {
      throw {
        kind: "conflict",
        message: "Something is at the page's path again, so it was not restored.",
      };
    }
    open.pages[path] = text;
    return { version: versionOf(open, path) };
  },
  page_create: (args?: InvokeArgs) => createEntry(args, "page"),
  folder_create: (args?: InvokeArgs) => createEntry(args, "folder"),
  world_new_location: () => {
    newLocation = previewLocations[0];
    return { location: newLocation };
  },
  world_new_browse: () => {
    newLocation = previewLocations[1];
    return { location: newLocation };
  },
  world_create: (args?: InvokeArgs): WorldOpened => {
    const { name } = args as { name: string };
    checkName(name);
    const created = createdWorlds[newLocation] ?? [];
    checkFree(created, name);
    createdWorlds[newLocation] = [...created, name];
    const next = emptyWorld(name);
    remember(next, `${newLocation}/${name}`);
    return opened(next);
  },
  // The preview always launches on the welcome screen.
  world_restore: () => null,
  recent_list: (): RecentWorld[] =>
    recentWorlds
      .filter((recent) => world === null || recent.world !== world)
      .map(({ world: _world, ...recent }) => recent),
  recent_remove: (args?: InvokeArgs) => {
    const { id } = args as { id: string };
    recentWorlds = recentWorlds.filter((recent) => recent.id !== id);
    return null;
  },
  world_open_recent: (args?: InvokeArgs): WorldOpened => {
    const { id } = args as { id: string };
    const recent = recentWorlds.find((entry) => entry.id === id);
    if (!recent) {
      throw { kind: "not_found", message: "This world is no longer in the recent list." };
    }
    if (!recent.world) {
      throw { kind: "world_missing", message: "The world's folder cannot be found." };
    }
    remember(recent.world, recent.path);
    return opened(recent.world);
  },
  workspace_save: () => null,
  app_close: () => null,
};
