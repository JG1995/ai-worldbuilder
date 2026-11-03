import { type ReactNode, useEffect, useState } from "react";
import type {
  AnswerReview,
  Backlinks as BacklinksState,
  DiffLine,
  PageMatch,
  ProposalReview as Proposal,
  TextMatch,
  TreeEntry,
} from "@/types/api";
import { Backlinks } from "@/ui/Backlinks";
import { Button } from "@/ui/Button";
import { FileTree, type TreeNameInput } from "@/ui/FileTree";
import type { MenuItem } from "@/ui/Menu";
import { Notice } from "@/ui/Notice";
import { NoPageOpen, PageView } from "@/ui/PageView";
import { ProposalReview } from "@/ui/ProposalReview";
import { SearchDialog, type SearchResults } from "@/ui/SearchDialog";
import { defaultAssistantWidth } from "@/ui/Shell";
import { WelcomeScreen } from "@/ui/WelcomeScreen";
import {
  largeSampleWorld,
  samplePageParagraphs,
  samplePageTitle,
  sampleRecentWorlds,
  sampleSelectedPath,
  sampleTree,
  sampleTreeExpanded,
  sampleWorldName,
} from "./sample-data";

// Every name, label and message here is sample data. The build guard in vite.config.ts keeps this
// module out of production builds.

const worldMenu: MenuItem[] = [
  { id: "new-page", label: "New page", shortcut: "Ctrl+N" },
  { id: "new-folder", label: "New folder" },
  { id: "close-world", label: "Close world" },
];

function contextMenuItems(target: TreeEntry | null): MenuItem[] {
  if (!target) return worldMenu.slice(0, 2);
  if (target.kind === "folder") {
    return [
      { id: "new-page", label: "New page here" },
      { id: "new-folder", label: "New folder here" },
      { id: "rename", label: "Rename", shortcut: "F2", disabled: true },
    ];
  }
  return [
    { id: "open-new-tab", label: "Open in new tab", shortcut: "Ctrl+click" },
    { id: "rename", label: "Rename", shortcut: "F2", disabled: true },
    { id: "delete", label: "Delete", shortcut: "Delete", destructive: true, disabled: true },
  ];
}

// Built on first use, so the showcase opens quickly.
let largeWorld: ReturnType<typeof largeSampleWorld> | undefined;

function Section({ title, use, children }: { title: string; use: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-divider border-t py-8">
      <div>
        <h2 className="label-caps text-text">{title}</h2>
        <p className="ui text-text-muted">{use}</p>
      </div>
      {children}
    </section>
  );
}

/** A labelled frame of a fixed height for a surface that fills its container. */
function Frame({
  title,
  height,
  children,
}: {
  title: string;
  height: number;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="ui-small text-text-muted">{title}</h3>
      <div className="overflow-hidden border border-divider" style={{ height }}>
        {children}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: string }) {
  return <p className="ui text-text-muted">Last event: {event}</p>;
}

function WelcomeSection() {
  const [event, setEvent] = useState("none yet");
  const handlers = {
    onOpenWorld: () => setEvent("Open world"),
    onNewWorld: () => setEvent("New world"),
    onChooseRecent: (id: string) => setEvent(`Choose recent world ${id}`),
    onRemoveRecent: (id: string) => setEvent(`Remove recent world ${id}`),
    onOpenSettings: () => setEvent("Settings"),
  };

  return (
    <Section title="Welcome screen" use="Shown when no world is open. One world is missing.">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-4">
        <Frame title="Recent worlds" height={640}>
          <WelcomeScreen recentWorlds={sampleRecentWorlds} {...handlers} />
        </Frame>
        <Frame title="No recent worlds" height={640}>
          <WelcomeScreen recentWorlds={[]} {...handlers} />
        </Frame>
      </div>
      <EventLine event={event} />
    </Section>
  );
}

function siblingsOf(entries: TreeEntry[], folder: string | null): TreeEntry[] {
  if (folder === null) return entries;
  for (const entry of entries) {
    if (entry.path === folder) return entry.children ?? [];
    const found = entry.children && siblingsOf(entry.children, folder);
    if (found) return found;
  }
  return [];
}

function FileTreeSection() {
  const [large, setLarge] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(sampleTreeExpanded));
  const [selected, setSelected] = useState<string | undefined>(sampleSelectedPath);
  const [nameInput, setNameInput] = useState<TreeNameInput>();
  const [event, setEvent] = useState("none yet");
  const entries = large ? (largeWorld?.tree ?? []) : sampleTree;

  function chooseLarge(next: boolean) {
    largeWorld ??= largeSampleWorld();
    setLarge(next);
    setExpanded(new Set(next ? largeWorld.folderPaths : sampleTreeExpanded));
    setSelected(next ? undefined : sampleSelectedPath);
    setNameInput(undefined);
  }

  function askForName(kind: TreeNameInput["kind"], folder: string | null, error?: string) {
    if (folder) setExpanded((current) => new Set(current).add(folder));
    setNameInput({ kind, folder, error });
    setEvent(kind === "page" ? "New page" : "New folder");
  }

  function submitName(name: string) {
    setEvent(`Name submitted: "${name}"`);
    if (!nameInput) return;
    const noun = nameInput.kind === "page" ? "page" : "folder";
    const trimmed = name.trim();
    const taken = siblingsOf(entries, nameInput.folder).some((entry) => entry.name === trimmed);
    if (!trimmed) setNameInput({ ...nameInput, error: `Enter a name for the ${noun}.` });
    else if (taken) setNameInput({ ...nameInput, error: `A ${noun} named "${trimmed}" exists.` });
    else setNameInput(undefined);
  }

  const handlers = {
    worldMenuItems: worldMenu,
    contextMenuItems,
    onOpen: (path: string, { newTab }: { newTab: boolean }) => {
      setSelected(path);
      setEvent(`Open ${path}${newTab ? " in a new tab" : ""}`);
    },
    onToggle: (path: string, open: boolean) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (open) next.add(path);
        else next.delete(path);
        return next;
      });
      setEvent(`${open ? "Expand" : "Collapse"} ${path}`);
    },
    onNameSubmit: submitName,
    onNameCancel: () => {
      setNameInput(undefined);
      setEvent("Name cancelled");
    },
  };

  return (
    <Section
      title="File tree"
      use="Arrow keys move, Right and Left expand and collapse, Enter opens, Shift+F10 opens the menu. Long names show in full on hover or focus."
    >
      <div className="flex flex-wrap items-center gap-4">
        <label className="ui flex items-center gap-2 text-text">
          <input
            type="checkbox"
            checked={large}
            onChange={(change) => chooseLarge(change.currentTarget.checked)}
            className="accent-accent"
          />
          Large sample world: 5,000 pages in 300 folders, all expanded
        </label>
        <Button
          variant="secondary"
          disabled={large}
          onClick={() => askForName("page", "People", 'A page named "Þórr" exists.')}
        >
          Show the name input with an error
        </Button>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="w-sidebar">
          <Frame title={large ? "Large sample world" : "Sample world"} height={560}>
            <FileTree
              worldName={large ? "Large sample world" : sampleWorldName}
              entries={entries}
              expanded={expanded}
              selected={selected}
              nameInput={nameInput}
              onWorldMenuSelect={(id) => {
                setEvent(`World menu: ${id}`);
                if (id === "new-page" || id === "new-folder") {
                  askForName(id === "new-page" ? "page" : "folder", null);
                }
              }}
              onContextMenuSelect={(id, target) => {
                setEvent(`Context menu: ${id} on ${target?.path ?? "the empty space"}`);
                const folder = target?.kind === "folder" ? target.path : null;
                if (id === "new-page" || id === "new-folder") {
                  askForName(id === "new-page" ? "page" : "folder", folder);
                }
              }}
              onNewPage={() => askForName("page", null)}
              onNewFolder={() => askForName("folder", null)}
              {...handlers}
            />
          </Frame>
        </div>
        <div className="w-sidebar">
          <Frame title="Empty world" height={240}>
            <FileTree
              worldName="Lantern Isles"
              entries={[]}
              expanded={new Set()}
              onWorldMenuSelect={(id) => setEvent(`World menu: ${id}`)}
              onContextMenuSelect={(id) => setEvent(`Context menu: ${id} on the empty space`)}
              onNewPage={() => setEvent("New page in the empty world")}
              onNewFolder={() => setEvent("New folder in the empty world")}
              {...handlers}
            />
          </Frame>
        </div>
      </div>
      <EventLine event={event} />
    </Section>
  );
}

function PageViewSection() {
  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState("none yet");

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoading(false), 2000);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return (
    <Section
      title="Page view"
      use="The reading measure and padding follow the pane's width. Loading shows after 300ms."
    >
      <Frame title="A page with a warning notice" height={520}>
        <PageView
          title={samplePageTitle}
          notices={
            <Notice
              status="warning"
              actions={
                <>
                  <Button variant="secondary">Keep mine</Button>
                  <Button variant="ghost">Load theirs</Button>
                  <Button variant="ghost">Compare</Button>
                </>
              }
            >
              Saltmere.md changed on disk while you were editing it.
            </Notice>
          }
        >
          {samplePageParagraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </PageView>
      </Frame>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-4">
        <div className="flex flex-col gap-2">
          <div>
            <Button variant="secondary" disabled={loading} onClick={() => setLoading(true)}>
              Load the page for 2 seconds
            </Button>
          </div>
          <Frame title="Loading: nothing for 300ms, then the title and Loading…" height={280}>
            <PageView title="Saltmere" loading={loading}>
              <p>{samplePageParagraphs[0]}</p>
            </PageView>
          </Frame>
        </div>
        <Frame title="No page open" height={320}>
          <NoPageOpen onNewPage={() => setEvent("New page")} />
        </Frame>
      </div>
      <EventLine event={event} />
    </Section>
  );
}

const sampleBacklinks: BacklinksState = {
  state: "ready",
  pages: [
    {
      path: "People/Captain Mirela.md",
      name: "Captain Mirela",
      line: "Her ship, the Gull, waits at [[Saltmere]] for the spring tide.",
      at: 31,
    },
    {
      path: "Sessions/Session 2.md",
      name: "Session 2",
      line: "…the party reaches [[Saltmere|the salt town]] after three days on the coast road, and finds the harbour closed by order of the guild, which nobody there will explain.",
      at: 40,
    },
    {
      path: "Archive/Session 2.md",
      name: "Session 2",
      line: "An older draft: [[Saltmere#Docks]] before the fire.",
      at: 16,
    },
  ],
};

function BacklinksSection() {
  const [event, setEvent] = useState("none yet");
  const onOpen = (path: string, at: number, { newTab }: { newTab: boolean }) =>
    setEvent(`Open ${path} at ${at}${newTab ? " in a new tab" : ""}`);
  const states: [string, BacklinksState][] = [
    ["Ready: two rows share a name, so they show their folders", sampleBacklinks],
    ["No backlinks", { state: "ready", pages: [] }],
    ["The index is being built", { state: "building" }],
    [
      "The index cannot be built",
      { state: "failed", message: "The world's folder cannot be read." },
    ],
  ];

  return (
    <Section
      title="Backlinks"
      use="Below each page. Click or Enter opens a row here; Ctrl+click, middle-click or Ctrl+Enter in a new tab."
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-4">
        {states.map(([title, backlinks]) => (
          <div key={title} className="flex min-w-0 flex-col gap-2">
            <h3 className="ui-small text-text-muted">{title}</h3>
            <div className="border border-divider bg-page p-4">
              <Backlinks backlinks={backlinks} onOpen={onOpen} />
            </div>
          </div>
        ))}
      </div>
      <EventLine event={event} />
    </Section>
  );
}

const sampleMatches: PageMatch[] = [
  {
    path: "Places/Mirror lake.md",
    name: "Mirror lake",
    field: "name",
    alias: null,
    mark: { from: 0, to: 3 },
  },
  {
    path: "People/Captain Mirela.md",
    name: "Captain Mirela",
    field: "name",
    alias: null,
    mark: { from: 8, to: 11 },
  },
  {
    path: "Kesh Tor.md",
    name: "Kesh Tor",
    field: "alias",
    alias: "Old Mire",
    mark: { from: 4, to: 7 },
  },
];

const sampleTexts: TextMatch[] = [
  {
    path: "Session notes/Session 4.md",
    name: "Session 4",
    lines: [
      {
        text: "Mirela's ship reaches the mirror lake at dusk.",
        at: 14,
        marks: [
          { from: 0, to: 6 },
          { from: 26, to: 32 },
        ],
      },
      {
        text: "…the crew swears Mirëla never sleeps.",
        at: 412,
        marks: [{ from: 17, to: 23 }],
      },
    ],
  },
  {
    path: "Lore/Tides.md",
    name: "Tides",
    lines: [
      {
        text: "The tide pulls the boats past Mirkwater.",
        at: 39,
        marks: [{ from: 30, to: 39 }],
      },
    ],
  },
];

/** Each state of the search dialog: its button's label, the query, the results, a create error. */
const searchStates: [string, string, SearchResults, string?][] = [
  [
    "Page matches, then text matches",
    "mir",
    {
      state: "ready",
      query: "mir",
      pages: sampleMatches,
      create: false,
      texts: sampleTexts,
      pending: false,
    },
  ],
  [
    "The Create row above text matches",
    "Saltmere harbour office",
    {
      state: "ready",
      query: "Saltmere harbour office",
      pages: [],
      create: true,
      texts: [
        {
          path: "Session notes/Session 3.md",
          name: "Session 3",
          lines: [
            {
              text: "The party asks at the Saltmere harbour office for passage.",
              at: 25,
              marks: [
                { from: 22, to: 30 },
                { from: 31, to: 38 },
                { from: 39, to: 45 },
              ],
            },
          ],
        },
      ],
      pending: false,
    },
  ],
  [
    "A path match",
    "places/sal",
    {
      state: "ready",
      query: "places/sal",
      pages: [
        {
          path: "Places/Saltmere.md",
          name: "Saltmere",
          field: "path",
          alias: null,
          mark: { from: 0, to: 10 },
        },
      ],
      create: false,
      texts: [],
      pending: false,
    },
  ],
  [
    "Nothing matches, with the Create row",
    "Saltmere harbour office",
    {
      state: "ready",
      query: "Saltmere harbour office",
      pages: [],
      create: true,
      texts: [],
      pending: false,
    },
  ],
  [
    "Indexing, with the pages read so far",
    "mir",
    {
      state: "building",
      query: "mir",
      pages: sampleMatches.slice(0, 1),
      create: false,
      texts: sampleTexts.slice(1),
      pending: false,
    },
  ],
  [
    "Pages cannot be searched",
    "mir",
    { state: "failed", query: "mir", message: "The world's folder cannot be read." },
  ],
  [
    "A refused creation",
    "Session 3: Harbour",
    {
      state: "ready",
      query: "Session 3: Harbour",
      pages: [],
      create: true,
      texts: [],
      pending: false,
    },
    'Names cannot contain / \\ : * ? " < > | or control characters, which some systems forbid.',
  ],
];

/** The dialog in one sample state; typing changes the query but not the sample results. */
function SampleSearch({ state, onEvent }: { state: number; onEvent: (event: string) => void }) {
  const [label, initialQuery, results, createError] = searchStates[state];
  const [query, setQuery] = useState(initialQuery);

  return (
    <SearchDialog
      query={query}
      onQueryChange={setQuery}
      results={results}
      createError={createError}
      onPick={(pick, { newTab }) => {
        const what =
          pick.kind === "page"
            ? `Open ${pick.path}`
            : pick.kind === "line"
              ? `Open ${pick.path} at ${pick.at}`
              : `Create "${results.query}"`;
        onEvent(`${what}${newTab ? " in a new tab" : ""} (${label})`);
      }}
      onClose={() => onEvent("Close")}
    />
  );
}

function SearchSection() {
  const [event, setEvent] = useState("none yet");
  const [shown, setShown] = useState<number | null>(null);

  return (
    <Section
      title="Search (quick open)"
      use="Ctrl+O or Ctrl+K in a world. Each button opens the dialog in one state; picking a row, Escape or a click outside closes it."
    >
      <div className="flex flex-wrap gap-2">
        {searchStates.map(([label], index) => (
          <Button key={label} variant="secondary" onClick={() => setShown(index)}>
            {label}
          </Button>
        ))}
      </div>
      <EventLine event={event} />
      {shown !== null && (
        <SampleSearch
          state={shown}
          onEvent={(next) => {
            setEvent(next);
            setShown(null);
          }}
        />
      )}
    </Section>
  );
}

const keshTorEdit: Proposal = {
  id: 1,
  kind: "edit",
  path: "Locations/Kesh Tor.md",
  page: "Locations/Kesh Tor.md",
  state: "pending",
  undone: false,
  accept: null,
  check: {
    state: "applies",
    lines: [
      { kind: "same", text: "# Kesh Tor" },
      { kind: "same", text: "" },
      { kind: "removed", text: "A basalt spire, the only shade for a day's ride." },
      { kind: "added", text: "A basalt spire, the only shade on the road to [[Saltmere]]." },
      { kind: "added", text: "Captain Mirela is held in its cellar." },
    ],
    version: "sample",
    changed: false,
  },
};

const longDiff: DiffLine[] = [
  { kind: "added", text: "# Saltmere" },
  { kind: "added", text: "" },
  ...[
    "A salt town at the steppe's edge, built on the bones of the old war.",
    "Caravans rest here before the crossing.",
    "## Districts",
    "- The Pans, where the salt is raked.",
    "- The Docks, on the dry lake bed.",
    "- The Lantern Ward, where the Guild keeps its lenses.",
    "## People",
    "- [[The salt merchant]] buys here.",
    "- Captain Mirela Dask commands the watch.",
    "## Rumours",
    "- A <b>glass</b> storm is coming.",
    "- The Guild wants the lake drained.",
  ].map((text): DiffLine => ({ kind: "added", text })),
];

const proposal = (fields: Partial<Proposal> & Pick<Proposal, "id" | "path">): Proposal => ({
  kind: "new_page",
  page: null,
  state: "pending",
  undone: false,
  accept: null,
  check: { state: "applies", lines: longDiff.slice(0, 3), version: null, changed: false },
  ...fields,
});

const answerReview = (
  proposals: Proposal[],
  accepted: AnswerReview["accepted"] = [],
): AnswerReview => ({ answer: 1, unreadable: 0, unfinished: false, proposals, accepted });

const sampleBatch = answerReview([
  proposal({
    id: 2,
    path: "Places/Saltmere.md",
    check: { state: "applies", lines: longDiff, version: null, changed: false },
  }),
  {
    ...keshTorEdit,
    check: keshTorEdit.check && { ...keshTorEdit.check, changed: true },
  } as Proposal,
  proposal({
    id: 3,
    kind: "edit",
    path: "Characters/Brother Ketil.md",
    page: "Characters/Brother Ketil.md",
    check: { state: "no_longer_applies", reason: "A passage is missing from the page." },
  }),
  proposal({ id: 4, path: "Characters/Mirela Dask.md" }),
]);

const sampleSettled = answerReview(
  [
    proposal({
      id: 2,
      path: "Places/Saltmere.md",
      page: "Places/Saltmere.md",
      state: "accepted",
      accept: 7,
      check: null,
    }),
    { ...keshTorEdit, state: "accepted", accept: 7, check: null },
    proposal({ id: 3, path: "Characters/Mirela Dask.md", state: "rejected", check: null }),
    proposal({ id: 4, path: "Places/Saltmere/Docks.md", undone: true }),
  ],
  [{ id: 7, count: 2, undo: true }],
);

const samplePartial = answerReview(
  [
    proposal({
      id: 2,
      path: "Places/Saltmere.md",
      page: "Places/Saltmere.md",
      state: "accepted",
      accept: 8,
      check: null,
    }),
    keshTorEdit,
  ],
  [{ id: 8, count: 1, undo: false }],
);

/** A frame as wide as the assistant pane, on its message ground. */
function ProposalFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="ui-small text-text-muted">{title}</h3>
      <div style={{ width: defaultAssistantWidth }} className="border border-divider bg-page p-4">
        {children}
      </div>
    </div>
  );
}

function ProposalSection() {
  const [event, setEvent] = useState("none yet");
  const handlers = {
    onAccept: async (ids: number[]) => {
      setEvent(`Accept ${ids.join(", ")}`);
      return null;
    },
    onReject: async (id: number) => {
      setEvent(`Reject ${id}`);
      return false;
    },
    onUndo: async (set: number) => {
      setEvent(`Undo set ${set}`);
      return false;
    },
    onOpenPage: (path: string, { newTab }: { newTab: boolean }) =>
      setEvent(`Open ${path}${newTab ? " in a new tab" : ""}`),
    onFocusComposer: () => setEvent("Focus the composer"),
  };

  return (
    <Section
      title="Proposal cards"
      use="The assistant's proposed changes below its answer, each a diff against the page as it is now. One proposal is a card; several are a batch list with a checkbox per proposal that applies and Accept selected. Only the newest pending set's Accept or Accept selected is primary. A long diff shows 12 lines until Show all. Settled cards collapse to their header and state, and each accepted set has Undo while its change can be undone."
    >
      <div className="flex flex-wrap items-start gap-4">
        <ProposalFrame title="A single card, the newest pending set">
          <ProposalReview
            review={answerReview([keshTorEdit])}
            newest
            failure={null}
            {...handlers}
          />
        </ProposalFrame>
        <ProposalFrame title="A batch list: a long diff, a changed page, one that no longer applies">
          <ProposalReview review={sampleBatch} newest failure={null} {...handlers} />
        </ProposalFrame>
        <ProposalFrame title="Settled cards with Undo, and an undone one, in an older answer">
          <ProposalReview review={sampleSettled} newest={false} failure={null} {...handlers} />
        </ProposalFrame>
        <ProposalFrame title="A write that failed partway; history did not record the accept">
          <ProposalReview
            review={samplePartial}
            newest={false}
            failure={{ proposal: 1, message: "The page is read-only." }}
            {...handlers}
          />
        </ProposalFrame>
      </div>
      <EventLine event={event} />
    </Section>
  );
}

/**
 * The content surfaces: welcome screen, file tree, page view, backlinks, search and proposal
 * cards. Their demos keep local state.
 */
export function SurfaceSections() {
  return (
    <>
      <WelcomeSection />
      <FileTreeSection />
      <PageViewSection />
      <BacklinksSection />
      <SearchSection />
      <ProposalSection />
    </>
  );
}
