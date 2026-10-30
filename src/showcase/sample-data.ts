// Sample names and text for the development-only showcase. The build guard in vite.config.ts
// keeps this module out of production builds.

import type { TreeEntry } from "../ui/FileTree";
import type { Tab } from "../ui/TabStrip";
import type { RecentWorld } from "../ui/WelcomeScreen";

export const sampleWorldName = "Saltmere";

/** Names outside basic Latin. Darker Grotesque lacks the breve letters, which fall back. */
export const samplePageTitle = "Þórr, Ærøskøbing and Ŵyn (ĕ ĭ ŏ)";

export const sampleHeading = "The drowned archive";

export const sampleBody =
  "The tide archive keeps every chart the harbour guild ever drew, and none of them agree.";

export const sampleLabel = "Recent worlds";

export const sampleCode = "aliases: [Saltmere Keep, The Keep]";

const page = (parent: string, name: string): TreeEntry => ({
  path: `${parent}${name}.md`,
  name,
  kind: "page",
});

function folder(parent: string, name: string, children: (path: string) => TreeEntry[]) {
  const path = `${parent}${name}`;
  return { path, name, kind: "folder", children: children(`${path}/`) } satisfies TreeEntry;
}

/** A small world with deep nesting, long names and names outside basic Latin. */
export const sampleTree: TreeEntry[] = [
  folder("", "Places", (places) => [
    folder(places, "The Northern Reaches", (north) => [
      folder(north, "Ærøskøbing", (town) => [
        folder(town, "Harbour district", (harbour) => [
          folder(harbour, "The drowned archive beneath the old customs house", (archive) => [
            page(archive, "Tide charts that the harbour guild drew, and none of them agree"),
            page(archive, "Archivist Ŵyn"),
          ]),
          page(harbour, "Customs house"),
        ]),
        page(town, "Ærøskøbing"),
      ]),
      page(north, "Saltmere"),
    ]),
    page(places, "Þórr's crossing"),
  ]),
  folder("", "People", (people) => [
    page(people, "Þórr"),
    page(people, "Ŵyn ap Gwyn"),
    page(people, "The Lantern Widow"),
  ]),
  folder("", "Sessions", (sessions) => [page(sessions, "Session 1"), page(sessions, "Session 2")]),
  page("", "World overview and the rules of the drowned coast that every player should know"),
];

export const sampleTreeExpanded = [
  "Places",
  "Places/The Northern Reaches",
  "Places/The Northern Reaches/Ærøskøbing",
  "Places/The Northern Reaches/Ærøskøbing/Harbour district",
  "Places/The Northern Reaches/Ærøskøbing/Harbour district/The drowned archive beneath the old customs house",
  "People",
];

export const sampleSelectedPath = "Places/The Northern Reaches/Saltmere.md";

const regions = [
  "Ashfold",
  "Brinehollow",
  "Cindermarch",
  "Duskwater",
  "Emberly",
  "Fenwatch",
  "Gloamreach",
  "Hollowmere",
  "Ironvale",
  "Jadecoast",
  "Kelpstrand",
  "Lanternfall",
  "Mirewood",
  "Nettlebarrow",
  "Oakensrift",
  "Pyrewall",
  "Quillmoor",
  "Ravenscar",
  "Saltmere",
  "Thornwick",
];

const districts = [
  "Archives",
  "Barrows",
  "Chapels",
  "Docks",
  "Estates",
  "Forges",
  "Gardens",
  "Harbour",
  "Inns",
  "Keeps",
  "Libraries",
  "Markets",
  "Ruins",
  "Shrines",
];

/**
 * A large world for the timing check: 300 folders (20 regions of 14 districts each) holding 5,000
 * pages (12 in each region and 17 in each district), with the paths of every folder. It is the same
 * on every call.
 */
export function largeSampleWorld() {
  const notes = (parent: string, prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      page(parent, `${prefix} note ${String(i + 1).padStart(2, "0")}`),
    );
  const tree = regions.map((region) =>
    folder("", region, (path) => [
      ...districts.map((district) => folder(path, district, (inner) => notes(inner, district, 17))),
      ...notes(path, region, 12),
    ]),
  );
  const folderPaths = tree.flatMap((region) => [
    region.path,
    ...region.children.flatMap((entry) => (entry.kind === "folder" ? [entry.path] : [])),
  ]);
  return { tree, folderPaths };
}

export const sampleRecentWorlds: RecentWorld[] = [
  { id: "saltmere", name: "Saltmere", path: "~/Worlds/Saltmere", missing: false },
  {
    id: "drowned-coast",
    name: "The Drowned Coast and the Lantern Isles",
    path: "~/Documents/Campaigns/2026/The Drowned Coast and the Lantern Isles",
    missing: false,
  },
  { id: "aeroskobing", name: "Ærøskøbing", path: "/mnt/backup/Worlds/Ærøskøbing", missing: true },
];

export const samplePageParagraphs = [
  "Saltmere is a harbour town built on the bones of an older one. At low tide the roofs of the drowned quarter show above the mud, and the guild sends its apprentices out to read the marks cut into the slates.",
  "The tide archive keeps every chart the harbour guild ever drew, and none of them agree. Archivist Ŵyn says that is the point: the sea keeps moving, and so does the town.",
];

export const sampleTabs: Tab[] = [
  { id: "saltmere", label: "Saltmere" },
  { id: "thorr", label: "Þórr" },
  { id: "customs-house", label: "Customs house" },
];

export const sampleLongTabs: Tab[] = [
  { id: "tide-charts", label: "Tide charts that the harbour guild drew, and none of them agree" },
  { id: "overview", label: "World overview and the rules of the drowned coast" },
  { id: "wyn", label: "Archivist Ŵyn" },
];

export const sampleManyTabs: Tab[] = Array.from({ length: 24 }, (_, i) => ({
  id: `session-${i + 1}`,
  label: `Session ${i + 1}`,
}));
