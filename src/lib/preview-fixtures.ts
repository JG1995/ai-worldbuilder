// An in-memory sample world for the browser preview (`pnpm dev`). Development builds only:
// `ipc.ts` loads this module behind `import.meta.env.DEV`, and `tools/check-dist.mjs` fails the
// check if the marker below, which every version token carries, appears in a production bundle.
import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
  Accepted,
  AnswerEnd,
  AnswerEvent,
  AnswerReview,
  Backlink,
  Backlinks,
  Comparison,
  ContextPage,
  Conversation,
  ConversationImages,
  Conversations,
  DiffLine,
  EditorLink,
  EditorLinks,
  GenerationFailure,
  HistoryVersion,
  ImageApproved,
  ImageEmbed,
  ImageFailure,
  ImageFrame,
  ImageReference,
  ImageRequest,
  ImageReview,
  ImageState,
  ImageTestOutcome,
  KeyStorage,
  LinkedPage,
  LinkSuggestions,
  NotGenerated,
  PageMatch,
  PageMatches,
  PageText,
  PageVersion,
  Properties,
  ProposalCheck,
  ProposalKind,
  ProposalReview,
  ProposalState,
  ProposalVersion,
  ProviderFailure,
  ProviderSaved,
  RecentWorld,
  RestoredPage,
  SavedMessage,
  Settings,
  StoreNotice,
  TestOutcome,
  TextLine,
  TextMatch,
  TextMatches,
  Theme,
  TreeEntry,
  Undone,
  VersionKind,
  Workspace,
  WorldOpened,
  WrittenPage,
} from "@/types/api";

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
  "Characters/Brother Ketil.md": "# Brother Ketil\n\nKeeper of the shrine at [[Kesh Tor]].\n",
  "Characters/Captain Orlaith Venn.md":
    "---\naliases: [Venn, The caravan master]\n---\n# Captain Orlaith Venn\n\nLeads the last caravan that still crosses in summer, guided by [[Brother Ketil|the old monk]].\n",
  "Characters/The salt merchant.md":
    "# The salt merchant\n\nNobody knows her name. She buys salt in [[Saltmere]].\n",
  "Factions/Glasswrights' Guild.md": "# Glasswrights' Guild\n\nThey mine the steppe for lenses.\n",
  "Factions/Riders of the Dun Sky.md": "# Riders of the Dun Sky\n\nNomads who never camp twice.\n",
  "Locations/Kesh Tor.md": "# Kesh Tor\n\nA basalt spire, the only shade for a day's ride.\n",
  "Locations/Locked chronicle.md":
    "# Locked chronicle\n\nIn the preview, another program holds this page open, so saving it always fails.\n",
  "Locations/Old trade ledger.md": { notUtf8: true },
  "Locations/The mirror lake.md": "# The mirror lake\n\nIts surface shows the sky of last night.\n",
  "Session notes/Session 1.md":
    "# Session 1\n\nThe party joins [[Captain Orlaith Venn|Venn]]'s caravan.\n",
  "Session notes/Session 2.md":
    "# Session 2\n\nA glass storm strands the caravan at [[Kesh Tor#Shelter]].\n",
  "Session notes/Session 10.md": "# Session 10\n\nThe Guild's lens finally works.\n",
  // Every element the live preview formats, for the specs and screenshots. Its words leave the
  // specs' searches, link suggestions and backlinks as they are.
  "Ward stones.md": `# Ward stones

Old circles mark safe ground on *dark* nights.

## Signs

Riders read **three** marks: ~~smoke~~, ==ash== and \`2d4\` for luck. #lore %%Keep quiet at sessions.%%

> [!warning]
> Never sleep outside a ring.

> [!tip] Placing a ring
> Seven stones, set at dusk.

> A rider's saying: stones remember.

- [ ] Count every stone
- [x] Mark a map
- Spare chalk

1. Walk around once
2. Speak a name

Guild records: [[Glasswrights' Guild]], [[Glasswrights' Guild|lens makers]] and [[Ash road]]. ^ward-1

---

\`\`\`
ring = 7 stones
\`\`\`

A [plain link](https://example.com) and an escaped \\*star\\*.

| Stone | Weight | Found by |
| :--- | :---: | ---: |
| **Granite** | \`9 kg\` | [[Glasswrights' Guild]] |
| Slate | 4 kg |
| Flint | 2 kg | a rider | lost |

| Ring | Northern | Eastern | Southern | Western | Centre | Capstone | Hearthstone | Waystone | Keystone | Lintel | Upkeep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Old ford | granite | slate | flint | sandstone | chalk | marble | schist | quartzite | limestone | gneiss | yearly |
`,
};

/**
 * The sample world's image files, their PNG bytes in base64. The tree shows no images, so they
 * leave the specs' tree and searches as they are.
 */
const sampleImages: Record<string, string> = {
  // 1200 × 300, wider than the reading measure.
  "Maps/The Glass Steppe.png":
    "iVBORw0KGgoAAAANSUhEUgAABLAAAAEsCAIAAABc390HAAAF50lEQVR42u3XQQ0AIAwAsUlBBy+kEFQgiSAIPfjYmlTB/S5anwAAABQUEgAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAhlAFAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAMAQqgAAAGAIAQAAMIQAAAAYQgAAAAwhAAAAaYbw3QUAAEBBhhAAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAMIQSAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAACGUAUAAABDCAAAgCEEAADAEAIAAGAIAQAAyDOEZw8AAAAKMoQAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAADCEAAACGEAAAAEMIAACAIQQAAMAQAgAAYAgBAAAwhAAAABhCAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAgCGUAAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAIAhBAAAwBACAABgCAEAADCEAAAAGEIAAAAMIQAAAIYQAAAAQwgAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAADAEAIAAGAIAQAAMIQAAAAYQgAAAAwhAAAAhhAAAABDCAAAgCEEAAAwhCoAAAAYQgAAAAwhAAAAhhAAAABDCAAAQBoflZQadXZsLJ0AAAAASUVORK5CYII=",
  // 120 × 160.
  "Characters/Brother Ketil.png":
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAIAAABIaz/HAAAA/ElEQVR42u3QQREAEBAAwIvjKYAAAgggiijCCKaC1z3MzmyCjVYLCUKBaNGIFi3agmjRiBYt2oJo0YgWLRrRohEtWjSiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNE8R5+9SCBatGhEixatQLRoRIsWbUG0aESLFm1BtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRItGtGjRiBaNaNGiES0a0aJFI/qL6DE7CUSLFo1o0aIViBaNaNGiLYgWjWjRoi2IFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRP/gAp3PFEved0J+AAAAAElFTkSuQmCC",
  // Bytes no browser can decode, for the "cannot be shown" placeholder.
  "Maps/Torn map.png": "dG9ybiBtYXA=",
};

/** The blob: URL of each sample image, made when the preview first resolves images. */
const sampleImageUrls = new Map<string, string>();

/** The URL of the sample image at `path`, once the preview has resolved images; empty otherwise. */
export function previewImageUrl(path: string) {
  return sampleImageUrls.get(path) ?? "";
}

function makeSampleImageUrls() {
  if (sampleImageUrls.size > 0) return;
  for (const [path, base64] of Object.entries(sampleImages)) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    sampleImageUrls.set(path, URL.createObjectURL(new Blob([bytes], { type: "image/png" })));
  }
}

/**
 * What an image embed of the page at `from` resolves to among the sample world's images, by the
 * core's rules for the cases the specs use. An approximation for the preview: the core also
 * refuses symbolic links and orders same-named images as the tree does.
 */
function imageOf(open: PreviewWorld, from: string, { target, form }: ImageRequest): ImageEmbed {
  const images = open === sampleWorld ? Object.keys(sampleImages) : [];
  let wanted = target;
  if (form === "markdown") {
    try {
      wanted = decodeURIComponent(wanted.replace(/^<(.*)>$/, "$1"));
    } catch {
      return { state: "missing" };
    }
  }
  if (/^(https?:|\/\/|data:)/i.test(wanted)) return { state: "web" };
  if (wanted.startsWith("/") || wanted.includes("\\") || /^[a-z]:/i.test(wanted)) {
    return { state: "outside" };
  }
  const folder = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  /** `wanted` from `base`, or null when its `..` leaves the world. */
  const joined = (base: string) => {
    const segments = base === "" ? [] : base.split("/");
    for (const segment of wanted.split("/")) {
      if (segment === "..") {
        if (segments.pop() === undefined) return null;
      } else if (segment !== "." && segment !== "") segments.push(segment);
    }
    return segments.join("/");
  };
  const bare = !wanted.includes("/");
  const relative = wanted.startsWith("./") || wanted.startsWith("../");
  let candidates: (string | null)[] = [joined(folder), joined("")];
  if (form === "wiki") candidates = relative ? [joined(folder)] : bare ? [] : [joined("")];
  const lexical = candidates.filter((candidate) => candidate !== null);
  if (candidates.length > 0 && lexical.length === 0) return { state: "outside" };
  if (lexical.some((path) => path.split("/").some((segment) => segment.startsWith(".")))) {
    return { state: "outside" };
  }
  const at = (path: string) => images.find((image) => image.toLowerCase() === path.toLowerCase());
  let found = lexical.map(at).find((image) => image !== undefined);
  if (!found && bare) {
    const named = images.filter(
      (image) => image.split("/").at(-1)?.toLowerCase() === wanted.toLowerCase(),
    );
    const depth = (image: string) => image.split("/").length;
    const inFolder = (image: string) => image.slice(0, Math.max(0, image.lastIndexOf("/")));
    found =
      named.find((image) => inFolder(image) === folder) ??
      named.sort((a, b) => depth(a) - depth(b))[0];
  }
  return found ? { state: "found", path: found, stamp: "1" } : { state: "missing" };
}

/** The page whose saves always fail, so the failed-save notice and dialog can be seen. */
const lockedPage = "Locations/Locked chronicle.md";

/** A change the preview recorded in a page's history: its text before (null: no page) and after. */
type PreviewChange = {
  id: number;
  path: string;
  kind: VersionKind;
  at: number;
  before: string | null;
  after: string;
};

/**
 * A preview world: its pages, the folders created in it, how often each page was saved, and the
 * changes recorded in its history, oldest first. Unlike the core, every save is a change of its own.
 */
type PreviewWorld = {
  name: string;
  pages: Record<string, SamplePage>;
  folders: Set<string>;
  saves: Record<string, number>;
  changes: PreviewChange[];
};

const emptyWorld = (name: string): PreviewWorld => ({
  name,
  pages: {},
  folders: new Set(),
  saves: {},
  changes: [],
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

/**
 * The tabs, their views and the conversation the assistant showed last of each preview world. An
 * approximation for the preview: of the workspace, only these survive reopening a world.
 */
const lastWorkspaces = new Map<
  PreviewWorld,
  Pick<Workspace, "tabs" | "active" | "reading" | "assistantConversation">
>();

function opened(next: PreviewWorld): WorldOpened {
  world = next;
  session += 1;
  return {
    name: next.name,
    session,
    workspace: {
      tabs: [],
      active: null,
      reading: [],
      assistantConversation: null,
      ...lastWorkspaces.get(next),
      expanded: [],
      treeWidth: 264,
      assistantOpen: true,
      assistantWidth: 360,
    },
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

let changeCount = 0;

/** Records a change of the page at `path` and returns its id. */
function record(
  open: PreviewWorld,
  path: string,
  kind: VersionKind,
  before: string | null,
  after: string,
) {
  const id = ++changeCount;
  open.changes.push({ id, path, kind, at: Math.floor(Date.now() / 1000), before, after });
  return id;
}

/**
 * A page's earlier versions with their texts, newest first, as the core derives them: each change's
 * text after it, and the text before it, labelled outside, when that is not the text listed last.
 */
function versionsOf(open: PreviewWorld, path: string) {
  const versions: (HistoryVersion & { text: string })[] = [];
  const push = (id: string, kind: VersionKind, at: number, text: string | null) => {
    if (text !== null && versions.at(-1)?.text !== text) versions.push({ id, kind, at, text });
  };
  for (const change of open.changes.filter((candidate) => candidate.path === path)) {
    push(`${change.id}-before`, "outside", change.at, change.before);
    push(`${change.id}-after`, change.kind, change.at, change.after);
  }
  return versions.reverse();
}

/** Puts `text` in the page at `path` like a write of the core's, with a new version. */
function writeText(open: PreviewWorld, path: string, text: string) {
  open.pages[path] = text;
  open.saves[path] = (open.saves[path] ?? 0) + 1;
}

const conflict = {
  kind: "conflict",
  message: "The page changed on disk since it was last read or saved.",
};

const escapedForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pages that link to the page at `path`, found by scanning the other pages for `[[name]]`,
 * `[[name|…]]` and `[[name#…]]` with the page's name, in any letter case. An approximation for the
 * preview: the core's index also resolves paths and aliases, and leaves out code and frontmatter.
 */
function backlinksOf(open: PreviewWorld, path: string): Backlink[] {
  const name = path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
  const link = new RegExp(`!?\\[\\[${escapedForPattern(name)}(?:[|#][^\\]\\n]*)?\\]\\]`, "i");
  const pages: Backlink[] = [];
  for (const [source, text] of Object.entries(open.pages)) {
    if (source === path || typeof text !== "string") continue;
    const found = link.exec(text);
    if (!found) continue;
    const lineStart = text.lastIndexOf("\n", found.index) + 1;
    const lineEnd = text.indexOf("\n", found.index);
    pages.push({
      path: source,
      name: source.split("/").at(-1)?.replace(/\.md$/i, "") ?? source,
      line: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
      at: found.index,
    });
  }
  return pages.sort((a, b) => byName.compare(a.name, b.name) || byName.compare(a.path, b.path));
}

const nameOf = (path: string) => path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;

/** The first page whose name equals a link's target in any letter case, by page name only. */
function pageNamed(open: PreviewWorld, target: string) {
  const wanted = target.toLowerCase();
  return Object.keys(open.pages).find((path) => nameOf(path).toLowerCase() === wanted) ?? null;
}

const attachment =
  /\.(png|jpe?g|gif|bmp|svg|webp|avif|mp3|wav|m4a|ogg|flac|3gp|mp4|webm|ogv|mov|mkv|pdf)$/i;

/**
 * The `[[…]]` links in a page's text, found with a regular expression and resolved by page name
 * only. An approximation for the preview: the core also resolves paths and aliases, and leaves out
 * code and frontmatter.
 */
function linksOf(open: PreviewWorld, from: string, text: string): EditorLink[] {
  return [...text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)].map((found) => {
    const [part, anchor = ""] = found[1].split("|")[0].split("#");
    const target = part.trim().replace(/\.md$/i, "");
    const path = target === "" ? from : pageNamed(open, target);
    const state = attachment.test(target) ? "attachment" : path ? "resolved" : "unresolved";
    return {
      from: found.index,
      to: found.index + found[0].length,
      state,
      target,
      path: state === "resolved" ? path : null,
      heading: anchor && !anchor.startsWith("^") ? anchor.trim() : null,
      block: anchor.startsWith("^") ? anchor.slice(1).trim() : null,
    };
  });
}

/**
 * Up to 10 pages other than `from` whose name starts with the query, then those whose name holds it
 * elsewhere, each group in path order. An approximation for the preview: the core also matches
 * aliases and paths, and writes the path of a page whose name another page shares.
 */
function suggestionsOf(open: PreviewWorld, from: string, query: string): LinkSuggestions {
  const wanted = query.trim().toLowerCase();
  const paths = Object.keys(open.pages)
    .filter((path) => path !== from)
    .sort(byName.compare);
  const at = (path: string) => nameOf(path).toLowerCase().indexOf(wanted);
  const items = [...paths.filter((path) => at(path) === 0), ...paths.filter((path) => at(path) > 0)]
    .slice(0, 10)
    .map((path) => ({ path, name: nameOf(path), alias: null, insert: nameOf(path) }));
  return { indexing: false, items };
}

/**
 * A page's aliases from an `aliases:` line in its frontmatter, as a list in brackets or one name:
 * enough for the preview's pages. The core reads the frontmatter as YAML.
 */
function aliasesOf(page: SamplePage) {
  if (typeof page !== "string" || !page.startsWith("---\n")) return [];
  const frontmatter = page.slice(4, page.indexOf("\n---", 3));
  const found = /^aliases:[ \t]*(.*)$/m.exec(frontmatter);
  if (!found) return [];
  const list = found[1].trim().replace(/^\[(.*)\]$/, "$1");
  return list
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

/**
 * The properties of a page's frontmatter from flat `key: value` and `key: [a, b]` lines: enough for
 * the preview's pages. Any other line answers `source`. The core reads the frontmatter as YAML.
 */
function propertiesOf(text: string): Properties {
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || end < 0) return { state: "none" };
  const rows = [];
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const found = /^([^\s:][^:]*):[ \t]*(.*)$/.exec(line);
    if (!found) return { state: "source" };
    const [, key, value] = found;
    const list = /^\[(.*)\]$/.exec(value.trim());
    rows.push({
      key,
      value: list
        ? { kind: "list" as const, items: list[1].split(",").map((item) => item.trim()) }
        : value.trim() === ""
          ? { kind: "empty" as const }
          : { kind: "text" as const, text: value.trim() },
    });
  }
  return rows.length === 0 ? { state: "none" } : { state: "rows", rows };
}

/**
 * A text in lowercase without accents, with the range in the original text, in UTF-16 code units,
 * of the character each of its code units came from, as the core folds names.
 */
function fold(text: string) {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const character of text) {
    const end = at + character.length;
    const parts = character.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    if (parts === "" && to.length > 0) to[to.length - 1] = end;
    for (const unit of parts.split("")) {
      folded += unit;
      from.push(at);
      to.push(end);
    }
    at = end;
  }
  return { folded, from, to };
}

/** Where the folded `query` first appears in `text`: whether at its start, and the mark. */
function matchIn(text: string, query: string) {
  const { folded, from, to } = fold(text);
  const at = folded.indexOf(query);
  if (at === -1) return null;
  return { start: at === 0, mark: { from: from[at], to: to[at + query.length - 1] } };
}

/**
 * Up to 10 pages whose name or alias, or for a query with a `/` whose path without `.md`, holds
 * the query, with letter case and accents ignored: a match at the start first, then a name or path
 * before an alias, then path order. An approximation of the core's ranking for the preview.
 */
function pageMatchesOf(open: PreviewWorld, query: string): PageMatches {
  const trimmed = query.trim();
  const wanted = fold(trimmed).folded;
  if (wanted === "") return { state: "ready", pages: [] };
  type Ranked = PageMatch & { start: boolean };
  const rank = (match: Ranked) => Number(!match.start) * 2 + Number(match.field === "alias");
  const matches: Ranked[] = [];
  for (const [path, text] of Object.entries(open.pages)) {
    const name = nameOf(path);
    const candidates: Ranked[] = [];
    const add = (found: ReturnType<typeof matchIn>, rest: Omit<PageMatch, "mark">) => {
      if (found) candidates.push({ ...rest, mark: found.mark, start: found.start });
    };
    if (trimmed.includes("/")) {
      add(matchIn(path.replace(/\.md$/i, ""), wanted), { path, name, field: "path", alias: null });
    } else {
      add(matchIn(name, wanted), { path, name, field: "name", alias: null });
      for (const alias of aliasesOf(text)) {
        add(matchIn(alias, wanted), { path, name, field: "alias", alias });
      }
    }
    const best = candidates.sort((a, b) => rank(a) - rank(b))[0];
    if (best) matches.push(best);
  }
  const pages = matches
    .sort((a, b) => rank(a) - rank(b) || byName.compare(a.path, b.path))
    .slice(0, 10)
    .map(({ start: _start, ...match }) => match);
  return { state: "ready", pages };
}

/** A text's words, as the core splits them: a letter or digit, then letters, digits and marks. */
const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/**
 * Up to 10 pages, other than the query's page matches, whose text holds every word of the query as
 * the start of a word, with letter case and accents ignored, each with its first 3 lines that hold
 * a match. An approximation for the preview: the core ranks the pages by relevance and cuts long
 * lines around their first match; here they come in path order, and lines are whole.
 */
function textMatchesOf(open: PreviewWorld, query: string): TextMatches {
  const wanted = [...query.matchAll(wordPattern)]
    .map(([word]) => fold(word).folded)
    .filter(Boolean);
  if (wanted.length === 0) return { state: "ready", pages: [] };
  const matched = pageMatchesOf(open, query);
  const listed = new Set(matched.state === "failed" ? [] : matched.pages.map((page) => page.path));
  const starts = (word: string) => wanted.some((start) => fold(word).folded.startsWith(start));
  const pages: TextMatch[] = [];
  for (const path of Object.keys(open.pages).sort(byName.compare)) {
    const text = open.pages[path];
    if (typeof text !== "string" || listed.has(path)) continue;
    const words = [...text.matchAll(wordPattern)].map(([word]) => fold(word).folded);
    if (!wanted.every((start) => words.some((word) => word.startsWith(start)))) continue;
    const lines: TextLine[] = [];
    let lineAt = 0;
    for (const line of text.split("\n")) {
      const marks = [...line.matchAll(wordPattern)]
        .filter(([word]) => starts(word))
        .map((found) => ({ from: found.index, to: found.index + found[0].length }));
      if (marks.length > 0 && lines.length < 3) {
        lines.push({ text: line, at: lineAt + marks[0].from, marks });
      }
      lineAt += line.length + 1;
    }
    pages.push({ path, name: nameOf(path), lines });
  }
  return { state: "ready", pages: pages.slice(0, 10) };
}

/**
 * Creates an empty page for a query typed in search like the core: `{query}.md` in the folder of
 * `from`, or at the query's path from the top level. An approximation for the preview: it joins no
 * `./` or `../`, refuses every hidden segment, and finds an existing page by its whole path in any
 * letter case.
 */
function createSearched(args: InvokeArgs | undefined): LinkedPage {
  const open = requireWorld();
  const { from, query } = args as { from: string | null; query: string };
  const trimmed = query.trim().replace(/\.md$/i, "");
  const segments = trimmed.split("/");
  const name = segments.pop() ?? "";
  const folders = trimmed.includes("/") ? segments : (from?.split("/").slice(0, -1) ?? []);
  const folder = folders.join("/");
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  const existing = Object.keys(open.pages).find(
    (candidate) => candidate.toLowerCase() === path.toLowerCase(),
  );
  if (existing) return { state: "existing", path: existing };
  if ([...folders, name].some((segment) => segment.startsWith("."))) {
    throw { kind: "invalid_path", message: "The link does not point to a page in this world." };
  }
  for (const segment of [...folders, name]) checkName(segment);
  checkFree(namesIn(open, folder || null), `${name}.md`);
  open.pages[path] = "";
  record(open, path, "new_page", null, "");
  return { state: "created", path };
}

/** Creates an empty page for an unresolved link like the core, without `./` and `../` paths. */
function createLinked(args: InvokeArgs | undefined): LinkedPage {
  const open = requireWorld();
  const { from, target } = args as { from: string; target: string };
  const existing = pageNamed(open, target);
  if (existing) return { state: "existing", path: existing };
  const segments = target.replace(/\.md$/i, "").split("/");
  const name = segments.pop() ?? "";
  const folder = target.includes("/") ? segments.join("/") : from.split("/").slice(0, -1).join("/");
  checkName(name);
  checkFree(namesIn(open, folder || null), `${name}.md`);
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  open.pages[path] = "";
  record(open, path, "new_page", null, "");
  return { state: "created", path };
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
  if (kind === "page") {
    open.pages[path] = "";
    record(open, path, "new_page", null, "");
  } else open.folders.add(path);
  return { path };
}

// The preview has no folder dialog: Browse… switches to the other sample location.
const previewLocations = ["/home/preview/Documents", "/home/preview/Campaigns"];
let newLocation = previewLocations[0];
/** The worlds created in each location this session, by name. */
const createdWorlds: Record<string, string[]> = {};

/** The preview's settings, in memory. They hold where a key is stored, never a key. */
let previewSettings: Settings = {
  ai: true,
  textProvider: null,
  imageProvider: null,
  theme: "saturn-seal",
};

function requireAi() {
  if (!previewSettings.ai) throw { kind: "ai_off", message: "AI features are off." };
}

/**
 * Saves the text provider like the core. An approximation for the preview: of the base URL rules
 * it checks only that the text is an `https` URL or an `http` URL on `localhost`, and every typed
 * key is stored in the keychain, except the key `no-keychain`, which answers as if no keychain
 * could be reached and, with `keyFile`, is stored in the key file.
 */
function saveProvider(args: InvokeArgs | undefined): ProviderSaved {
  requireAi();
  const { baseUrl, model, key, keyFile } = args as {
    baseUrl: string;
    model: string;
    key: string | null;
    keyFile: boolean;
  };
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      state: "invalid",
      field: "base_url",
      message: "Enter the full address of the provider, starting with https://.",
    };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    return {
      state: "invalid",
      field: "base_url",
      message:
        "The address must start with https://, or with http:// for a server on this computer.",
    };
  }
  if (model.trim() === "") {
    return { state: "invalid", field: "model", message: "Enter the model's ID." };
  }
  const typed = key?.trim() || null;
  const previous = previewSettings.textProvider;
  let storage: KeyStorage;
  if (typed === "no-keychain") {
    if (!keyFile) return { state: "no_keychain" };
    storage = "file";
  } else if (typed) storage = "keychain";
  else if (previous && new URL(previous.baseUrl).origin === url.origin) storage = previous.key;
  else storage = "none";
  void stopAnswer();
  previewSettings = {
    ...previewSettings,
    ai: true,
    textProvider: { baseUrl: trimmed, model: model.trim(), key: storage, host: url.host },
  };
  return { state: "saved", settings: previewSettings };
}

const providerFailures: ProviderFailure[] = [
  "unreachable",
  "insecure",
  "timeout",
  "key_refused",
  "key_needed",
  "not_found",
  "rate_limited",
  "refused",
  "provider_error",
  "redirected",
  "invalid_reply",
  "key_unreadable",
  "interrupted",
];

/**
 * Tests the saved provider without a network. An approximation for the preview: it answers after
 * a short delay, and a saved model `fail:<reason>`, with a `ProviderFailure` as the reason, fails for
 * that reason with a sample detail and provider message; any other model connects.
 */
async function testProvider(): Promise<TestOutcome> {
  requireAi();
  const provider = previewSettings.textProvider;
  if (!provider) throw { kind: "not_found", message: "No provider is saved." };
  await new Promise((resolve) => setTimeout(resolve, 600));
  const reason = providerFailures.find((failure) => provider.model === `fail:${failure}`);
  if (!reason) return { state: "connected" };
  return {
    state: "failed",
    reason,
    detail: "Sample detail from the preview",
    providerMessage: "Sample message from the provider, with <b>markup</b> shown as text.",
  };
}

/**
 * Saves the image provider like the core. As for the text provider, every typed key is stored in
 * the keychain, except the key `no-keychain`, which answers as if no keychain could be reached and,
 * with `keyFile`, is stored in the key file.
 */
function saveImageProvider(args: InvokeArgs | undefined): ProviderSaved {
  requireAi();
  const { model, key, keyFile } = args as { model: string; key: string | null; keyFile: boolean };
  if (model.trim() === "") {
    return { state: "invalid", field: "model", message: "Enter the model's ID." };
  }
  const typed = key?.trim() || null;
  const stored = previewSettings.imageProvider?.key ?? "none";
  let storage: KeyStorage;
  if (typed === "no-keychain") {
    if (!keyFile) return { state: "no_keychain" };
    storage = "file";
  } else if (typed) storage = "keychain";
  else if (stored !== "none") storage = stored;
  else return { state: "invalid", field: "key", message: "Enter the API key." };
  previewSettings = {
    ...previewSettings,
    imageProvider: { model: model.trim(), key: storage, host: "openrouter.ai" },
  };
  return { state: "saved", settings: previewSettings };
}

/**
 * Tests the saved image provider without a network. An approximation for the preview: it answers
 * after a short delay, and fails as an unknown model when the saved model contains `unknown`.
 */
async function testImageProvider(): Promise<ImageTestOutcome> {
  requireAi();
  const provider = previewSettings.imageProvider;
  if (!provider || provider.key === "none") {
    throw { kind: "not_found", message: "No image provider is saved." };
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (!provider.model.includes("unknown")) return { state: "success" };
  return {
    state: "failed",
    reason: "unknown_model",
    detail: null,
    providerMessage: "Sample message from the provider, with <b>markup</b> shown as text.",
  };
}

/**
 * A proposal kept with its answer: a new page's text, or an edit's passages, with the page's text
 * when the answer ended. An approximation for the preview: the core keeps a hash of that text.
 */
type PreviewProposal = {
  id: number;
  kind: ProposalKind;
  /** As the model gave it, until an accept writes it. */
  path: string;
  text: string;
  changes: { find: string; replace: string }[];
  base: string | null;
  state: ProposalState;
  undone: boolean;
  accept: number | null;
  /** Its write always fails, so that a partial accept can be seen. */
  failing: boolean;
};

/** An accepted set: what its accept wrote, each page's text before (null: no page) and after. */
type PreviewSet = {
  id: number;
  answer: number;
  writes: { path: string; before: string | null; after: string }[];
};

/** Each saved answer's proposals, by the answer's id, and the accepted sets, by their id. */
const proposalsOf = new Map<number, PreviewProposal[]>();
const acceptedSets = new Map<number, PreviewSet>();
let nextProposal = 1;
let nextSet = 1;

/** The path with `.md` added once, as the core's proposal path rules add it. */
const withMd = (path: string) => (/\.md$/i.test(path) ? path : `${path}.md`);

/** The page at `path` in any letter case, as the core maps a path to its spelling on disk. */
const pageAt = (open: PreviewWorld, path: string) =>
  Object.keys(open.pages).find((candidate) => candidate.toLowerCase() === path.toLowerCase()) ??
  null;

/**
 * Whether a pending proposal applies to its page as it is now, with the text it would write. An
 * approximation of the core's checks for the preview: it knows no path rules beyond `.md`.
 */
function checkOf(
  open: PreviewWorld,
  proposal: PreviewProposal,
): { page: string | null; check: ProposalCheck; result: string | null } {
  const page = pageAt(open, withMd(proposal.path));
  const refused = (reason: string) => ({
    page,
    check: { state: "no_longer_applies", reason } as const,
    result: null,
  });
  if (proposal.kind === "new_page") {
    if (page !== null) return refused("A page with this name already exists.");
    const lines = linesOf(proposal.text).map((text) => ({ kind: "added", text }) as const);
    const check = { state: "applies", lines, version: null, changed: false } as const;
    return { page, check, result: proposal.text };
  }
  if (page === null) return refused("The page does not exist.");
  const text = open.pages[page];
  if (typeof text !== "string") return refused("The page is not UTF-8 text.");
  let result = text;
  for (const { find, replace } of proposal.changes) {
    const at = result.indexOf(find);
    if (at === -1) return refused("A passage is missing from the page.");
    if (result.indexOf(find, at + 1) !== -1) {
      return refused("A passage appears more than once in the page.");
    }
    result = result.slice(0, at) + replace + result.slice(at + find.length);
  }
  if (result === text) return refused("The edit makes no change.");
  const check = {
    state: "applies",
    lines: compareLines(text, result),
    version: versionOf(open, page),
    changed: proposal.base !== text,
  } as const;
  return { page, check, result };
}

/** The proposals of a conversation's answers, as `assistant_review` gives them. */
function reviewOf(open: PreviewWorld, conversation: PreviewConversation): AnswerReview[] {
  return conversation.messages.flatMap((message) => {
    const proposals = message.role === "answer" ? proposalsOf.get(message.id) : undefined;
    if (message.role !== "answer" || !proposals) return [];
    const reviewed = proposals.map((proposal): ProposalReview => {
      const { id, kind, path, state, undone, accept } = proposal;
      const { page, check } = checkOf(open, proposal);
      const pending = state === "pending";
      return { id, kind, path, page, state, undone, accept, check: pending ? check : null };
    });
    const accepted = [...acceptedSets.values()]
      .filter((set) => set.answer === message.id)
      .map((set) => ({
        id: set.id,
        count: proposals.filter((proposal) => proposal.accept === set.id).length,
        undo: true,
      }));
    return [
      { answer: message.id, unreadable: 0, unfinished: false, proposals: reviewed, accepted },
    ];
  });
}

/**
 * Writes the chosen proposals of an answer as one change, like the core: nothing when one does not
 * apply or its version differs, and up to the first write that fails otherwise. An approximation
 * for the preview: each page is recorded as a change of its own in the preview's history.
 */
function acceptProposals(answer: number, chosen: ProposalVersion[]): Accepted {
  requireAi();
  const open = requireWorld();
  if (chosen.length === 0) throw { kind: "conflict", message: "No proposal was chosen." };
  const proposals = proposalsOf.get(answer) ?? [];
  const checked = chosen.map(({ id, version }) => {
    const proposal = proposals.find((candidate) => candidate.id === id);
    if (proposal?.state !== "pending") {
      throw { kind: "conflict", message: "The proposal is no longer pending." };
    }
    const { page, check, result } = checkOf(open, proposal);
    if (check.state !== "applies" || result === null) {
      throw { kind: "conflict", message: check.state === "applies" ? "" : check.reason };
    }
    if (check.version !== version) throw conflict;
    return { proposal, path: page ?? withMd(proposal.path), result };
  });
  const written: WrittenPage[] = [];
  const writes: PreviewSet["writes"] = [];
  let failure: Accepted["failure"] = null;
  for (const { proposal, path, result } of checked) {
    if (proposal.failing) {
      failure = { proposal: proposal.id, message: "The page is read-only." };
      break;
    }
    const before = proposal.kind === "edit" ? (open.pages[path] as string) : null;
    writeText(open, path, result);
    record(open, path, before === null ? "accepted_new_page" : "accepted_edit", before, result);
    written.push({ path, text: result, version: versionOf(open, path) });
    writes.push({ path, before, after: result });
  }
  if (writes.length === 0) {
    return { set: null, accepted: 0, of: chosen.length, written, failure, undo: false };
  }
  const set = nextSet++;
  acceptedSets.set(set, { id: set, answer, writes });
  for (const { proposal, path } of checked.slice(0, writes.length)) {
    Object.assign(proposal, { state: "accepted", accept: set, path });
  }
  return { set, accepted: writes.length, of: chosen.length, written, failure, undo: true };
}

/**
 * Undoes an accepted set all or nothing, like the core: it writes nothing when a page changed since,
 * and deletes the pages the accept created. An approximation for the preview: a deletion is not
 * recorded in the preview's history.
 */
function undoSet(id: number): Undone {
  requireAi();
  const open = requireWorld();
  const set = acceptedSets.get(id);
  if (!set) throw { kind: "not_found", message: "This change cannot be undone." };
  const changed = set.writes.find(({ path, after }) => open.pages[path] !== after);
  if (changed) {
    throw {
      kind: "conflict",
      message: `“${nameOf(changed.path)}” changed since it was written, so nothing was undone. Its history still holds every version.`,
    };
  }
  const restored: WrittenPage[] = [];
  const deleted: string[] = [];
  for (const { path, before, after } of set.writes) {
    if (before === null) {
      delete open.pages[path];
      deleted.push(path);
    } else {
      writeText(open, path, before);
      record(open, path, "undo", after, before);
      restored.push({ path, text: before, version: versionOf(open, path) });
    }
  }
  for (const proposal of proposalsOf.get(set.answer) ?? []) {
    if (proposal.accept === id)
      Object.assign(proposal, { state: "pending", undone: true, accept: null });
  }
  acceptedSets.delete(id);
  return { restored, deleted };
}

/** Rejects a pending proposal for good. */
function rejectProposal(id: number) {
  requireAi();
  requireWorld();
  const proposal = [...proposalsOf.values()].flat().find((candidate) => candidate.id === id);
  if (proposal?.state !== "pending") {
    throw { kind: "conflict", message: "The proposal is no longer pending." };
  }
  proposal.state = "rejected";
  return null;
}

/**
 * The canned proposals for a message `propose:`: a new page, an edit of the active page (or of
 * Kesh Tor without one), and another new page; `propose-fail:` adds an edit of The mirror lake
 * whose write always fails.
 */
function cannedProposals(open: PreviewWorld, active: string | null, failing: boolean) {
  const draft = (
    kind: ProposalKind,
    path: string,
    content: Pick<PreviewProposal, "text" | "changes">,
    fails = false,
  ): Omit<PreviewProposal, "id"> => ({
    kind,
    path,
    ...content,
    base: null,
    state: "pending",
    undone: false,
    accept: null,
    failing: fails,
  });
  const lastLine = (path: string) => {
    const text = open.pages[path];
    return typeof text === "string"
      ? linesOf(text)
          .filter((line) => line.trim() !== "")
          .at(-1)
      : undefined;
  };
  const target =
    active !== null && lastLine(active) !== undefined ? active : "Locations/Kesh Tor.md";
  const line = lastLine(target) ?? "";
  const proposals = [
    draft("new_page", "Places/Saltmere", {
      text: "# Saltmere\n\nA salt town at the steppe's edge, where [[The salt merchant]] buys her salt.\n",
      changes: [],
    }),
    draft("edit", target, {
      text: "",
      changes: [
        {
          find: line,
          replace: `${line}\n\nThe caravan from [[Saltmere]] stops here on its way north.`,
        },
      ],
    }),
    draft("new_page", "Characters/Mirela Dask.md", {
      text: "# Mirela Dask\n\nCaptain of the Saltmere watch. <b>Not</b> to be trusted.\n",
      changes: [],
    }),
  ];
  if (failing) {
    const lake = "# The mirror lake";
    proposals.push(
      draft(
        "edit",
        "Locations/The mirror lake.md",
        {
          text: "",
          changes: [{ find: lake, replace: `${lake}\n\nSaltmere draws its water here.` }],
        },
        true,
      ),
    );
  }
  return proposals;
}

/** The answer the preview is streaming; a stop wakes it from its pause and waits for its end. */
type Answering = { stopped: boolean; wake: () => void; ended: Promise<void>; end: () => void };
let answering: Answering | null = null;

type PreviewConversation = Conversation & { updated: number };

/**
 * Each preview world's conversations, newest last, and its storage notice. An approximation for
 * the preview: they are kept in memory for as long as the page stays loaded, and a message
 * `store:set_aside` or `store:not_saved` makes the world report that notice.
 */
const conversationsOf = new Map<PreviewWorld, PreviewConversation[]>();
const storeNotices = new Map<PreviewWorld, StoreNotice>();
let nextConversation = 1;
let nextAnswer = 1;

function conversationsIn(open: PreviewWorld) {
  const known = conversationsOf.get(open) ?? [];
  conversationsOf.set(open, known);
  return known;
}

function requireConversation(open: PreviewWorld, id: unknown) {
  const found = conversationsIn(open).find((conversation) => conversation.id === id);
  if (!found) throw { kind: "not_found", message: "The conversation does not exist." };
  return found;
}

const nowInSeconds = () => Math.floor(Date.now() / 1000);

/** Saves how an answer ended in its conversation, as the core does, and returns its id. */
function saveAnswer(conversation: PreviewConversation, end: AnswerEnd, pages: ContextPage[]) {
  const state = end.state === "failed" ? (end.text === "" ? null : "stopped") : end.state;
  if (state === null) return null;
  const time = nowInSeconds();
  const id = nextAnswer++;
  const answer: SavedMessage = {
    role: "answer",
    id,
    text: end.text,
    time,
    state,
    pages,
    leftOut: 0,
    indexing: false,
  };
  conversation.messages.push(answer);
  conversation.updated = time;
  return id;
}

/** Waits `ms` milliseconds, or until a stop. */
function pause(run: Answering, ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    run.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** Stops the answer being streamed, if any, once it has ended. */
async function stopAnswer() {
  if (!answering) return;
  answering.stopped = true;
  answering.wake();
  await answering.ended;
}

/** The canned answer, in chunks of a few words, naming the active page and linking a page. */
function cannedAnswer(active: string | null) {
  const about = active ? `[[${nameOf(active)}]]` : "this world";
  const text = `The pages I read say this about ${about}:\n\n- Caravans cross the steppe by night, when the glass is cool.\n- [[Brother Ketil]] keeps the shrine at [[Kesh Tor]], the only shade for a day's ride.\n\nAsk about another page to compare them.`;
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += 3) {
    chunks.push(words.slice(start, start + 3).join(""));
  }
  return chunks;
}

/**
 * The pages a message's request carries: the active page, then each page a `[[link]]` in the
 * message names, then each page whose name the message holds as whole words in any letter case,
 * each once. An approximation for the preview: the core also resolves paths and aliases, folds
 * accents, and adds the pages one link away and the pages whose text matches, within its budgets.
 */
function contextOf(open: PreviewWorld, active: string | null, message: string): ContextPage[] {
  const isText = (path: string | null): path is string =>
    path !== null && typeof open.pages[path] === "string";
  const linked = linksOf(open, "", message).map((link) => link.path);
  const wholeWords = (name: string) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapedForPattern(name)}($|[^\\p{L}\\p{N}])`, "iu");
  const named = Object.keys(open.pages)
    .filter((path) => wholeWords(nameOf(path)).test(message))
    .sort();
  const paths = [...new Set([active, ...linked, ...named].filter(isText))];
  return paths.map((path) => ({ path, partial: false }));
}

/**
 * Answers a message without a network. An approximation for the preview: the request carries
 * the pages `contextOf` chooses; the canned answer streams in chunks about 100 ms apart; a message
 * `fail:<reason>`, with a `ProviderFailure` as the reason, fails for that reason with a sample
 * detail and provider message; a message starting `propose:` or `propose-fail:` streams a short
 * answer and the canned proposals, each about 100 ms apart, which are kept with the saved answer;
 * a retry is accepted whatever the last answer was.
 */
async function sendAnswer(
  args: Record<string, unknown>,
  onEvent: (event: AnswerEvent) => void,
): Promise<AnswerEnd> {
  requireAi();
  const open = requireWorld();
  if (!previewSettings.textProvider) throw { kind: "not_found", message: "No provider is saved." };
  if (answering) throw { kind: "conflict", message: "An answer is already running." };
  const { conversation, text, active, retry, regenerates } = args as {
    conversation: number | null;
    text: string;
    active: string | null;
    retry: boolean;
    regenerates?: number;
  };
  let shown: PreviewConversation;
  let message: string;
  /** The image the message regenerates, if it is a regeneration message. */
  let regenerated: PreviewImage | undefined;
  if (retry) {
    if (conversation === null) {
      throw { kind: "not_found", message: "There is no message to answer again." };
    }
    shown = requireConversation(open, conversation);
    if (shown.messages.at(-1)?.role === "answer") shown.messages.pop();
    const asked = shown.messages.at(-1);
    if (asked?.role !== "user") {
      throw { kind: "not_found", message: "There is no message to answer again." };
    }
    message = asked.text;
    regenerated = previewImages.find((image) => image.id === regenerationsOf.get(asked));
  } else {
    if (text.trim() === "") throw { kind: "invalid_name", message: "The message is empty." };
    const time = nowInSeconds();
    if (conversation === null) {
      const title = text.trim().split("\n")[0].slice(0, 60);
      shown = { id: nextConversation++, title, messages: [], updated: time };
      conversationsIn(open).push(shown);
    } else {
      shown = requireConversation(open, conversation);
    }
    if (regenerates !== undefined) {
      const answers = shown.messages.flatMap((saved) =>
        saved.role === "answer" ? [saved.id] : [],
      );
      regenerated = previewImages.find(
        (image) => image.id === regenerates && answers.includes(image.answer),
      );
      if (!regenerated) throw { kind: "not_found", message: "The image does not exist." };
    }
    const user: SavedMessage = { role: "user", text, time };
    if (regenerated) regenerationsOf.set(user, regenerated.id);
    shown.messages.push(user);
    shown.updated = time;
    message = text;
    if (message === "store:set_aside") storeNotices.set(open, { kind: "set_aside" });
    if (message === "store:not_saved") {
      const reason = "The conversation store cannot be written.";
      storeNotices.set(open, { kind: "not_saved", reason });
    }
  }
  const id = shown.id;
  const pages = contextOf(open, active, message);
  const failing = message.startsWith("propose-fail:");
  const proposing = failing || message.startsWith("propose:");
  /** The proposals streamed so far, which are kept with the saved answer. */
  const proposed: PreviewProposal[] = [];
  const requested = imageRequestOf(message, regenerated);
  /** The image request has been streamed whole, so it is kept with the saved answer. */
  let imageStreamed = false;
  const saved = (end: AnswerEnd): AnswerEnd => {
    const answer = saveAnswer(shown, end, pages);
    if (answer !== null && proposed.length > 0) proposalsOf.set(answer, proposed);
    if (answer !== null && requested && imageStreamed) {
      const image: PreviewImage = {
        ...requested,
        id: nextImage++,
        answer,
        state: "not_generated",
        notGenerated: end.state === "stopped" ? "stopped" : "no_provider",
        failure: null,
        undone: false,
        path: null,
        revises: regenerated?.id ?? null,
        reference: null,
        createdFolder: false,
      };
      previewImages.push(image);
      if (end.state !== "stopped" && imageProviderSaved()) generateImage(image);
    }
    return { ...end, answer };
  };

  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const run: Answering = { stopped: false, wake: () => {}, ended, end };
  answering = run;
  try {
    onEvent({ kind: "context", conversation: id, pages, leftOut: 0, indexing: false });
    let answer = "";
    const reason = providerFailures.find((failure) => message === `fail:${failure}`);
    if (reason) {
      await pause(run, 300);
      if (run.stopped)
        return saved({ state: "stopped", conversation: id, text: answer, answer: null });
      return saved({
        state: "failed",
        conversation: id,
        text: answer,
        answer: null,
        reason,
        detail: "Sample detail from the preview",
        providerMessage: "Sample message from the provider, with <b>markup</b> shown as text.",
      });
    }
    const deltas = proposing
      ? ["Here is how Saltmere ", "could fit in. ", "Review each change ", "before it is written."]
      : requested
        ? [
            "I wrote the prompt ",
            "from the pages I read. ",
            "Review the image ",
            "before it is saved.",
          ]
        : cannedAnswer(active);
    for (const delta of deltas) {
      await pause(run, 100);
      if (run.stopped)
        return saved({ state: "stopped", conversation: id, text: answer, answer: null });
      answer += delta;
      onEvent({ kind: "text", delta });
    }
    for (const draft of proposing ? cannedProposals(open, active, failing) : []) {
      await pause(run, 100);
      if (run.stopped)
        return saved({ state: "stopped", conversation: id, text: answer, answer: null });
      const page = pageAt(open, withMd(draft.path));
      const base = page === null ? null : (open.pages[page] as string);
      proposed.push({ ...draft, id: nextProposal++, base });
      onEvent({ kind: "proposal", change: draft.kind, path: draft.path });
    }
    if (requested) {
      onEvent({ kind: "image", name: requested.name });
      await pause(run, 100);
      if (run.stopped)
        return saved({ state: "stopped", conversation: id, text: answer, answer: null });
      imageStreamed = true;
    }
    return saved({ state: "complete", conversation: id, text: answer, answer: null });
  } finally {
    answering = null;
    run.end();
  }
}

/**
 * An image request kept with its saved answer. An approximation for the preview: a generation
 * reaches no network and ends within the command that starts it, with a sample image, because no
 * `assistant:image-changed` event reaches the preview.
 */
type PreviewImage = {
  id: number;
  answer: number;
  name: string;
  frame: ImageFrame;
  prompt: string;
  state: ImageState;
  notGenerated: NotGenerated | null;
  failure: GenerationFailure | null;
  undone: boolean;
  path: string | null;
  revises: number | null;
  reference: ImageReference | null;
  /** The sample image whose bytes it has once generated. */
  sample: string;
  /** What each generation does: end with the sample image, keep running until Cancel, or fail. */
  outcome: "ready" | "hold" | ImageFailure;
  /** Its approval created the world's `images` folder. */
  createdFolder: boolean;
};

const previewImages: PreviewImage[] = [];
/** The image each regeneration message regenerates. */
const regenerationsOf = new WeakMap<SavedMessage, number>();
let nextImage = 1;

const imageFailures: ImageFailure[] = [
  "unreachable",
  "insecure",
  "timeout",
  "key_refused",
  "no_credit",
  "unknown_model",
  "rate_limited",
  "refused",
  "provider_error",
  "redirected",
  "invalid_reply",
  "no_image",
  "key_unreadable",
  "interrupted",
];

/** The URL of the sample image a stored image shows, once it has been generated. */
export function previewStoredImageUrl(id: number) {
  const image = previewImages.find((candidate) => candidate.id === id);
  if (!image) return "";
  makeSampleImageUrls();
  return sampleImageUrls.get(image.sample) ?? "";
}

function requireImage(id: unknown) {
  const image = previewImages.find((candidate) => candidate.id === id);
  if (!image) throw { kind: "not_found", message: "The image does not exist." };
  return image;
}

/** Whether an image provider is saved with a key, as generating needs. */
const imageProviderSaved = () =>
  previewSettings.imageProvider !== null && previewSettings.imageProvider.key !== "none";

/** Runs an image's generation, which ends at once unless it holds. */
function generateImage(image: PreviewImage) {
  if (image.revises !== null) {
    const earlier = previewImages.find((candidate) => candidate.id === image.revises);
    image.reference = earlier && earlier.state !== "rejected" ? "sent" : "gone";
  }
  if (image.outcome === "hold") {
    Object.assign(image, { state: "generating", notGenerated: null, failure: null });
  } else if (image.outcome === "ready") {
    Object.assign(image, { state: "pending", notGenerated: null, failure: null });
  } else {
    const failure: GenerationFailure = {
      reason: image.outcome,
      detail: "Sample detail from the preview",
      providerMessage: "Sample message from the provider, with <b>markup</b> shown as text.",
    };
    Object.assign(image, { state: "not_generated", notGenerated: "failed", failure });
  }
}

/**
 * The image request of an answer to `message`: one for a message asking for an image, portrait,
 * picture or scene, or regenerating `regenerates`; none otherwise. A portrait is of Brother Ketil
 * with his sample image, anything else of the Glass Steppe with its map. A message holding
 * `image-hold` keeps the generation running until Cancel, and one holding `image-fail:<reason>`,
 * with an `ImageFailure` as the reason, fails it for that reason.
 */
function imageRequestOf(message: string, regenerates: PreviewImage | undefined) {
  if (!regenerates && !/\b(images?|portraits?|pictures?|scenes?)\b/i.test(message)) return null;
  const outcome: PreviewImage["outcome"] =
    imageFailures.find((reason) => message.includes(`image-fail:${reason}`)) ??
    (message.includes("image-hold") ? "hold" : "ready");
  if (regenerates) {
    const { name, frame, prompt, sample } = regenerates;
    return { name, frame, prompt: `${prompt} ${message.trim()}`, sample, outcome };
  }
  if (/portrait/i.test(message)) {
    return {
      name: "Brother Ketil",
      frame: "portrait" as const,
      prompt:
        "Ink and watercolour portrait. A gaunt monk in his fifties with a shaved head and a sun-dark face, in a dusty grey robe, at the shrine of Kesh Tor. Head and shoulders, three-quarter view. Low evening light; ochre and slate.",
      sample: "Characters/Brother Ketil.png",
      outcome,
    };
  }
  return {
    name: "The Glass Steppe",
    frame: "landscape" as const,
    prompt:
      "Ink and watercolour landscape. A plain of fused, glittering sand under a night sky, a caravan of camels crossing it in single file. Wide view from a low ridge. Moonlight; deep blues and pale silver.",
    sample: "Maps/The Glass Steppe.png",
    outcome,
  };
}

/** An image as `assistant_images` reviews it. */
function imageReviewOf(image: PreviewImage): ImageReview {
  const { id, name, frame, prompt, state, notGenerated, failure, undone, path, reference } = image;
  const earlier = previewImages.find((candidate) => candidate.id === image.revises);
  return {
    id,
    name,
    frame,
    prompt,
    state,
    notGenerated,
    failure,
    undone,
    path,
    undo: state === "approved",
    revises: earlier?.id ?? null,
    revisesName: earlier?.name ?? null,
    reference,
  };
}

/** A conversation's images by answer, and its regeneration messages, as the core gives them. */
function imagesOfConversation(conversation: PreviewConversation): ConversationImages {
  const answers = conversation.messages.flatMap((message) => {
    if (message.role !== "answer") return [];
    const images = previewImages.filter((image) => image.answer === message.id);
    if (images.length === 0) return [];
    return [
      { answer: message.id, unreadable: 0, unfinished: false, images: images.map(imageReviewOf) },
    ];
  });
  const regenerations = conversation.messages.flatMap((message, index) => {
    const image = regenerationsOf.get(message);
    const earlier = previewImages.find((candidate) => candidate.id === image);
    return earlier ? [{ message: index, image: earlier.id, name: earlier.name }] : [];
  });
  return { answers, regenerations };
}

/**
 * Writes a pending image to `images/` at the world's top level, like the core: an `images` folder
 * in any letter case is used, and a taken name gains " 2", " 3" and so on. An approximation for
 * the preview: the image file stays out of the world's pages, as the tree shows no images, and the
 * name is cleaned of the characters page names forbid only.
 */
function approveImage(id: unknown): ImageApproved {
  requireAi();
  const open = requireWorld();
  const image = requireImage(id);
  if (image.state !== "pending") {
    throw { kind: "conflict", message: "The image is no longer pending." };
  }
  const existing = [...open.folders].find((folder) => folder.toLowerCase() === "images");
  const folder = existing ?? "images";
  const stem = image.name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Image";
  const taken = (path: string) =>
    previewImages.some((other) => other.path?.toLowerCase() === path.toLowerCase());
  let path = `${folder}/${stem}.png`;
  for (let number = 2; taken(path); number++) path = `${folder}/${stem} ${number}.png`;
  open.folders.add(folder);
  Object.assign(image, { state: "approved", path, createdFolder: existing === undefined });
  return { path, undo: true };
}

/** Undoes an image's approval, removing the `images` folder it created once nothing is in it. */
function undoImage(id: unknown) {
  requireAi();
  const open = requireWorld();
  const image = requireImage(id);
  if (image.state !== "approved" || image.path === null) {
    throw { kind: "conflict", message: "The image is no longer approved." };
  }
  const folder = image.path.slice(0, image.path.lastIndexOf("/"));
  Object.assign(image, { state: "pending", undone: true, path: null });
  const holds = previewImages.some((other) => other.path?.startsWith(`${folder}/`));
  if (image.createdFolder && !holds) open.folders.delete(folder);
  image.createdFolder = false;
  return null;
}

/** The addresses `link_open` was asked to open; the preview opens nothing. */
export const openedAddresses: string[] = [];

/** A host whose addresses never open, so the failure toast can be seen. */
const unopenableHost = "unopenable.example";

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
  page_write: (args?: InvokeArgs): PageVersion => {
    const { open, path, text } = pageText(args);
    const { text: edited, version } = args as { text: string; version: string };
    if (version !== versionOf(open, path)) throw conflict;
    if (open === sampleWorld && path === lockedPage) {
      throw { kind: "io", message: "Another program is using the file." };
    }
    if (edited !== text) {
      writeText(open, path, edited);
      record(open, path, "edit", text, edited);
    }
    return { version: versionOf(open, path) };
  },
  history_list: (args?: InvokeArgs): HistoryVersion[] => {
    const { open, path, text } = pageText(args);
    const versions = versionsOf(open, path);
    const firstEarlier = versions.findIndex((version) => version.text !== text);
    return versions
      .slice(firstEarlier === -1 ? versions.length : firstEarlier)
      .map(({ id, kind, at }) => ({ id, kind, at }));
  },
  history_compare: (args?: InvokeArgs): DiffLine[] => {
    const { open, path } = pageText(args);
    const { version, text } = args as { version: string; text: string };
    const earlier = versionsOf(open, path).find((candidate) => candidate.id === version);
    if (!earlier) {
      throw { kind: "not_found", message: "This version is no longer in the page's history." };
    }
    return compareLines(earlier.text, text);
  },
  history_restore: (args?: InvokeArgs): RestoredPage => {
    const { open, path, text } = pageText(args);
    const { version, pageVersion } = args as { version: string; pageVersion: string };
    if (pageVersion !== versionOf(open, path)) throw conflict;
    const earlier = versionsOf(open, path).find((candidate) => candidate.id === version);
    if (!earlier) {
      throw { kind: "not_found", message: "This version is no longer in the page's history." };
    }
    if (earlier.text === text) return { text, version: versionOf(open, path), change: null };
    writeText(open, path, earlier.text);
    const change = record(open, path, "restore", text, earlier.text);
    return { text: earlier.text, version: versionOf(open, path), change: String(change) };
  },
  history_undo: (args?: InvokeArgs): RestoredPage => {
    const open = requireWorld();
    const { change } = args as { change: string };
    const undone = open.changes.find((candidate) => String(candidate.id) === change);
    if (!undone || undone.before === null) {
      throw { kind: "not_found", message: "This change cannot be undone." };
    }
    if (open.pages[undone.path] !== undone.after) {
      const name = undone.path.split("/").at(-1)?.replace(/\.md$/i, "");
      throw {
        kind: "conflict",
        message: `“${name}” changed since the restore, so nothing was undone. Its history still holds every version.`,
      };
    }
    writeText(open, undone.path, undone.before);
    const id = record(open, undone.path, "undo", undone.after, undone.before);
    return { text: undone.before, version: versionOf(open, undone.path), change: String(id) };
  },
  // The preview simulates no outside changes, so neither is reached from its pages; both answer
  // like the core.
  page_compare: (args?: InvokeArgs): Comparison => {
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
  workspace_save: (args?: InvokeArgs) => {
    const { tabs, active, reading, assistantConversation } = (args as { workspace: Workspace })
      .workspace;
    lastWorkspaces.set(requireWorld(), { tabs, active, reading, assistantConversation });
    return null;
  },
  app_close: () => null,
  backlinks_list: (args?: InvokeArgs): Backlinks => {
    const { path } = args as { path: string };
    return { state: "ready", pages: backlinksOf(requireWorld(), path) };
  },
  links_in: (args?: InvokeArgs): EditorLinks => {
    const { path, text } = args as { path: string; text: string };
    return { state: "ready", links: linksOf(requireWorld(), path, text) };
  },
  images_resolve: (args?: InvokeArgs): ImageEmbed[] => {
    const { path, embeds } = args as { path: string; embeds: ImageRequest[] };
    const open = requireWorld();
    makeSampleImageUrls();
    return embeds.map((embed) => imageOf(open, path, embed));
  },
  link_open: (args?: InvokeArgs) => {
    const { address } = args as { address: string };
    openedAddresses.push(address);
    if (new URL(address).hostname === unopenableHost) {
      throw { kind: "io", message: "No browser could be started." };
    }
    return null;
  },
  page_properties: (args?: InvokeArgs): Properties => {
    const { text } = args as { text: string };
    return propertiesOf(text);
  },
  link_create: (args?: InvokeArgs) => createLinked(args),
  link_suggest: (args?: InvokeArgs) => {
    const { from, query } = args as { from: string; query: string };
    return suggestionsOf(requireWorld(), from, query);
  },
  search_pages: (args?: InvokeArgs) => {
    const { query } = args as { query: string };
    return pageMatchesOf(requireWorld(), query);
  },
  search_text: (args?: InvokeArgs) => {
    const { query } = args as { query: string };
    return textMatchesOf(requireWorld(), query);
  },
  search_create: (args?: InvokeArgs) => createSearched(args),
  settings_get: (): Settings => previewSettings,
  settings_ai_set: (args?: InvokeArgs): Settings => {
    const { on } = args as { on: boolean };
    if (!on) void stopAnswer();
    previewSettings = { ...previewSettings, ai: on };
    return previewSettings;
  },
  settings_theme_set: (args?: InvokeArgs): Settings => {
    const { theme } = args as { theme: Theme };
    previewSettings = { ...previewSettings, theme };
    return previewSettings;
  },
  provider_save: (args?: InvokeArgs) => saveProvider(args),
  provider_key_remove: (): Settings => {
    requireAi();
    const provider = previewSettings.textProvider;
    if (provider) {
      void stopAnswer();
      previewSettings = { ...previewSettings, textProvider: { ...provider, key: "none" } };
    }
    return previewSettings;
  },
  provider_test: () => testProvider(),
  provider_test_cancel: () => null,
  image_provider_save: (args?: InvokeArgs) => saveImageProvider(args),
  image_provider_key_remove: (): Settings => {
    requireAi();
    const provider = previewSettings.imageProvider;
    if (provider)
      previewSettings = { ...previewSettings, imageProvider: { ...provider, key: "none" } };
    return previewSettings;
  },
  image_provider_test: () => testImageProvider(),
  image_provider_test_cancel: () => {
    requireAi();
    return null;
  },
  // A streaming command: `invokeStreaming` calls it with the event handler too.
  assistant_send: sendAnswer,
  // Resolves by page name only, as `links_in` does in the preview, from the world's top level.
  assistant_links: (args?: InvokeArgs): EditorLinks => {
    requireAi();
    const { text } = args as { text: string };
    return { state: "ready", links: linksOf(requireWorld(), "", text) };
  },
  assistant_stop: async () => {
    requireAi();
    await stopAnswer();
    return null;
  },
  assistant_conversations: (): Conversations => {
    requireAi();
    const open = requireWorld();
    const items = conversationsIn(open)
      .map(({ id, title, updated }) => ({ id, title, updated }))
      .sort((a, b) => b.updated - a.updated || b.id - a.id);
    return { items, notice: storeNotices.get(open) ?? null };
  },
  assistant_conversation: (args?: InvokeArgs): Conversation => {
    requireAi();
    const { id, title, messages } = requireConversation(
      requireWorld(),
      (args as { id: number }).id,
    );
    return { id, title, messages: [...messages] };
  },
  assistant_review: (args?: InvokeArgs): AnswerReview[] => {
    requireAi();
    const open = requireWorld();
    return reviewOf(
      open,
      requireConversation(open, (args as { conversation: number }).conversation),
    );
  },
  assistant_accept: (args?: InvokeArgs): Accepted => {
    const { answer, proposals } = args as { answer: number; proposals: ProposalVersion[] };
    return acceptProposals(answer, proposals);
  },
  assistant_reject: (args?: InvokeArgs) => rejectProposal((args as { proposal: number }).proposal),
  assistant_undo: (args?: InvokeArgs): Undone => undoSet((args as { set: number }).set),
  assistant_images: (args?: InvokeArgs): ConversationImages => {
    requireAi();
    const open = requireWorld();
    const { conversation } = args as { conversation: number };
    return imagesOfConversation(requireConversation(open, conversation));
  },
  assistant_image_generate: (args?: InvokeArgs) => {
    requireAi();
    requireWorld();
    const image = requireImage((args as { image: number }).image);
    if (!imageProviderSaved()) throw { kind: "not_found", message: "No image provider is saved." };
    if (image.state !== "not_generated") {
      throw { kind: "conflict", message: "The image is not waiting to be generated." };
    }
    generateImage(image);
    return null;
  },
  assistant_image_cancel: (args?: InvokeArgs) => {
    requireAi();
    requireWorld();
    const image = requireImage((args as { image: number }).image);
    if (image.state === "generating") {
      Object.assign(image, { state: "not_generated", notGenerated: "cancelled" });
    }
    return null;
  },
  assistant_image_reject: (args?: InvokeArgs) => {
    requireAi();
    requireWorld();
    const image = requireImage((args as { image: number }).image);
    if (image.state !== "pending") {
      throw { kind: "conflict", message: "The image is no longer pending." };
    }
    image.state = "rejected";
    return null;
  },
  assistant_image_approve: (args?: InvokeArgs) => approveImage((args as { image: number }).image),
  assistant_image_undo: (args?: InvokeArgs) => undoImage((args as { image: number }).image),
  assistant_delete: async (args?: InvokeArgs) => {
    requireAi();
    const open = requireWorld();
    const { id } = args as { id: number };
    requireConversation(open, id);
    // An approximation for the preview: it stops whatever answer runs, in any conversation.
    await stopAnswer();
    conversationsOf.set(
      open,
      conversationsIn(open).filter((conversation) => conversation.id !== id),
    );
    return null;
  },
};
