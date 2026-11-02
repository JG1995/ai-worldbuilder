import { type ReactNode, useState } from "react";
import type { ConversationSummary, EditorLink, StoreNotice } from "@/types/api";
import { AssistantPane, type ChatMessage } from "@/ui/AssistantPane";
import { Button } from "@/ui/Button";
import { FileTree } from "@/ui/FileTree";
import { defaultAssistantWidth, defaultTreeWidth } from "@/ui/Shell";
import { type Tab, TabStrip } from "@/ui/TabStrip";
import {
  sampleLongTabs,
  sampleManyTabs,
  sampleTabs,
  sampleTree,
  sampleTreeExpanded,
  sampleWorldName,
} from "./sample-data";

// Every label here is sample data. The build guard in vite.config.ts keeps this module out of
// production builds.

/** The tabs and active tab after closing `id`: a closed active tab hands over to its neighbour. */
export function closeTab(tabs: Tab[], activeId: string | undefined, id: string) {
  const index = tabs.findIndex((tab) => tab.id === id);
  const rest = tabs.filter((tab) => tab.id !== id);
  const nextActive = id === activeId ? (rest[index] ?? rest[index - 1])?.id : activeId;
  return { tabs: rest, activeId: nextActive };
}

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

function TabStripDemo({
  title,
  initialTabs,
  onEvent,
}: {
  title: string;
  initialTabs: Tab[];
  onEvent: (event: string) => void;
}) {
  const [tabs, setTabs] = useState(initialTabs);
  const [activeId, setActiveId] = useState<string | undefined>(initialTabs[1]?.id);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-3">
        <h3 className="ui-small text-text-muted">{title}</h3>
        {tabs.length < initialTabs.length && (
          <Button
            variant="ghost"
            onClick={() => {
              setTabs(initialTabs);
              setActiveId(initialTabs[1]?.id);
            }}
          >
            Reopen all
          </Button>
        )}
      </div>
      <div className="border border-divider">
        <TabStrip
          tabs={tabs}
          activeId={activeId}
          onActivate={(id) => {
            setActiveId(id);
            onEvent(`Activate ${id}`);
          }}
          onClose={(id) => {
            const next = closeTab(tabs, activeId, id);
            setTabs(next.tabs);
            setActiveId(next.activeId);
            onEvent(`Close ${id}`);
          }}
        />
        <div className="h-12 bg-page" />
      </div>
    </div>
  );
}

/** The tabs with the first one's page holding changes waiting for review. */
const samplePendingTabs: Tab[] = sampleTabs.map((tab, index) =>
  index === 0 ? { ...tab, pending: true } : tab,
);

/** Rows an accept could have written: two shown, and one inside a collapsed folder. */
const sampleWrittenPaths = [
  "Places/The Northern Reaches/Saltmere.md",
  "People/Þórr.md",
  "Sessions/Session 2.md",
];

/** The tree at its default width, whose button flashes the rows an accept wrote. */
function TreeFlashDemo({ onEvent }: { onEvent: (event: string) => void }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(sampleTreeExpanded));
  const [flashed, setFlashed] = useState<ReadonlySet<string>>(new Set());

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h3 className="ui-small text-text-muted">Rows an accept wrote flash once</h3>
        <Button variant="ghost" onClick={() => setFlashed(new Set(sampleWrittenPaths))}>
          Flash rows
        </Button>
      </div>
      <div style={{ width: defaultTreeWidth }} className="h-80 border border-divider">
        <FileTree
          worldName={sampleWorldName}
          entries={sampleTree}
          expanded={expanded}
          flashed={flashed}
          worldMenuItems={[]}
          onWorldMenuSelect={() => {}}
          contextMenuItems={() => []}
          onContextMenuSelect={() => {}}
          onOpen={(path) => onEvent(`Open ${path}`)}
          onToggle={(path, open) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (open) next.add(path);
              else next.delete(path);
              return next;
            })
          }
          onNewPage={() => onEvent("New page")}
          onNewFolder={() => onEvent("New folder")}
          onNameSubmit={() => {}}
          onNameCancel={() => {}}
        />
      </div>
    </div>
  );
}

/** The assistant pane's content at its default width, as the shell shows it. */
function AssistantPaneFrame({
  title,
  tall = false,
  children,
}: {
  title: string;
  tall?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="ui-small text-text-muted">{title}</h3>
      <div
        style={{ width: defaultAssistantWidth }}
        className={`flex flex-col border border-divider bg-page ${tall ? "h-120" : "h-60"}`}
      >
        {children}
      </div>
    </div>
  );
}

const keshTor = { path: "Locations/Kesh Tor.md", partial: false, gone: false };

const sampleAnswer =
  "[[Brother Ketil]] keeps the shrine at [[Kesh Tor]], the only shade for a day's ride.\n\n- He guided Venn's caravan.\n- He is called *the old monk*.\n\nNo page tells of the [[Winter road]] yet.";

/** The link to `target` in the sample answer, resolved to `path` when there is one. */
function sampleLink(target: string, path: string | null): EditorLink {
  const from = sampleAnswer.indexOf(`[[${target}]]`);
  return {
    from,
    to: from + target.length + 4,
    state: path ? "resolved" : "unresolved",
    target,
    path,
    heading: null,
    block: null,
  };
}

/** A complete answer with its links and disclosure, then an answer still arriving. */
const sampleConversation: ChatMessage[] = [
  { id: 1, role: "user", text: "Who keeps the shrine at Kesh Tor?" },
  {
    id: 2,
    role: "answer",
    text: sampleAnswer,
    state: "complete",
    context: {
      pages: [
        keshTor,
        { path: "Characters/Brother Ketil.md", partial: true, gone: false },
        { path: "Old notes.md", partial: false, gone: true },
      ],
      leftOut: 2,
      indexing: true,
    },
    failure: null,
    links: [
      sampleLink("Brother Ketil", "Characters/Brother Ketil.md"),
      sampleLink("Kesh Tor", "Locations/Kesh Tor.md"),
      sampleLink("Winter road", null),
    ],
  },
  { id: 3, role: "user", text: "And where does he go in winter?" },
  {
    id: 4,
    role: "answer",
    text: "The pages do not say where he",
    state: "streaming",
    context: { pages: [keshTor], leftOut: 0, indexing: false },
    failure: null,
  },
];

/** A stopped answer, then one that failed because the provider limits requests. */
const sampleEndings: ChatMessage[] = [
  { id: 1, role: "user", text: "Describe the glass storm." },
  {
    id: 2,
    role: "answer",
    text: "A glass storm strands the caravan at",
    state: "stopped",
    context: { pages: [], leftOut: 0, indexing: false },
    failure: null,
  },
  { id: 3, role: "user", text: "Describe it again, briefly." },
  {
    id: 4,
    role: "answer",
    text: "",
    state: "failed",
    context: { pages: [keshTor], leftOut: 0, indexing: false },
    failure: {
      reason: "rate_limited",
      detail: null,
      providerMessage: "Rate limit exceeded: 20 requests per minute.",
    },
  },
];

/** A message whose answer never arrived, as after a crash, then the last one, which can be retried. */
const sampleUnanswered: ChatMessage[] = [
  { id: 1, role: "user", text: "Who rules Saltmere?" },
  { id: 2, role: "user", text: "Who rules Saltmere now?" },
];

const sampleConversations: ConversationSummary[] = [
  { id: 3, title: "Who keeps the shrine at Kesh Tor?", updated: 1_798_800_000 },
  { id: 2, title: "Describe the glass storm.", updated: 1_798_700_000 },
  {
    id: 1,
    title: "A long first line that the core cut to sixty characters for t",
    updated: 1_798_600_000,
  },
];

/** The pane with a conversation, its composer holding a local draft. */
function AssistantChatDemo({
  messages,
  storeNotice,
  onEvent,
}: {
  messages: ChatMessage[];
  storeNotice?: StoreNotice;
  onEvent: (event: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <AssistantPane
      model="mistral-small-latest"
      host="api.mistral.ai"
      onOpenSettings={() => onEvent("Open Settings")}
      onNewConversation={() => onEvent("New conversation")}
      onShowConversations={() => onEvent("Conversations")}
      storeNotice={storeNotice}
      chat={{
        messages,
        draft,
        onDraftChange: setDraft,
        onSend: () => onEvent(`Send "${draft}"`),
        onStop: () => onEvent("Stop"),
        onRetry: () => onEvent("Retry"),
        onOpenPage: (path, { newTab }) => onEvent(`Open ${path}${newTab ? " in a new tab" : ""}`),
        onFollowLink: (link) => onEvent(`Follow [[${link.target}]]`),
        onCopy: () => onEvent("Copy the answer"),
        refusal: null,
        announcement: "",
      }}
    />
  );
}

/** The pane's conversations list, whose Delete asks first and removes the row here. */
function AssistantListDemo({
  initialItems,
  onEvent,
}: {
  initialItems: ConversationSummary[];
  onEvent: (event: string) => void;
}) {
  const [items, setItems] = useState(initialItems);
  return (
    <AssistantPane
      model="mistral-small-latest"
      host="api.mistral.ai"
      onOpenSettings={() => onEvent("Open Settings")}
      onNewConversation={() => onEvent("New conversation")}
      onShowConversations={() => onEvent("Conversations")}
      conversations={{
        items,
        error: null,
        onOpen: (id) => onEvent(`Open conversation ${id}`),
        onDelete: async (id) => {
          setItems((shown) => shown.filter((item) => item.id !== id));
          onEvent(`Delete conversation ${id}`);
        },
        onBack: () => onEvent("Back"),
      }}
    />
  );
}

/** The tab strip's and the assistant pane's demos, and where the shell is composed. */
export function ShellSections() {
  const [event, setEvent] = useState("none yet");

  return (
    <>
      <Section
        title="Tab strip"
        use="Left and Right move focus, Enter or Space activates, middle-click closes. Ctrl+Tab cycles the first strip on this page, because each strip handles it on the window."
      >
        <TabStripDemo title="A few tabs" initialTabs={sampleTabs} onEvent={setEvent} />
        <TabStripDemo
          title="Many tabs: the strip scrolls and lists every tab in a menu"
          initialTabs={sampleManyTabs}
          onEvent={setEvent}
        />
        <TabStripDemo
          title="Long labels: an ellipsis, and the full label on hover or focus"
          initialTabs={sampleLongTabs}
          onEvent={setEvent}
        />
        <p className="ui text-text-muted">Last event: {event}</p>
      </Section>
      <Section
        title="Changes from the assistant"
        use="A tab whose page has changes waiting for review shows an info dot, with its tooltip on hover or focus. The tree rows an accept wrote take the selection fill once and fade back; with reduced motion the fill holds briefly instead. Rows inside a collapsed folder do not flash."
      >
        <TabStripDemo
          title="Changes waiting for review on Saltmere"
          initialTabs={samplePendingTabs}
          onEvent={setEvent}
        />
        <TreeFlashDemo onEvent={setEvent} />
      </Section>
      <Section
        title="Shell"
        use="The tree pane and the page region side by side from 960px, and the tree as an overlay below. With AI on, the assistant pane sits beside the page from 1280px and is an overlay below; the Assistant button at the tab strip's right end and Ctrl+Shift+A open and close it. F6 moves between the panes."
      >
        <p className="ui text-text">
          The shell composes the other surfaces, the assistant pane included, in the{" "}
          <a href="#sample-world" className="text-accent underline">
            sample world screen
          </a>
          .
        </p>
      </Section>
      <Section
        title="Assistant pane"
        use="The pane's content: its header with New conversation and Conversations, then the notice that asks for a provider and the storage notices, or the explanation of an empty conversation, which names where messages go; the conversation, with each answer's Read N pages disclosure, its marks and failures, and the line under a message whose answer never arrived; and the composer, where Enter sends and Send becomes Stop while an answer arrives. The conversations list replaces the conversation and the composer; Delete asks first."
      >
        <div className="flex flex-wrap gap-4">
          <AssistantPaneFrame title="No provider saved">
            <AssistantPane onOpenSettings={() => setEvent("Open Settings")} />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="A provider saved">
            <AssistantPane
              model="mistral-small-latest"
              host="api.mistral.ai"
              onOpenSettings={() => setEvent("Open Settings")}
            />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="An answer arriving" tall>
            <AssistantChatDemo messages={sampleConversation} onEvent={setEvent} />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="A stopped answer and a failure" tall>
            <AssistantChatDemo messages={sampleEndings} onEvent={setEvent} />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="No answer arrived; earlier conversations set aside" tall>
            <AssistantChatDemo
              messages={sampleUnanswered}
              storeNotice={{ kind: "set_aside" }}
              onEvent={setEvent}
            />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="Conversations not being saved" tall>
            <AssistantChatDemo
              messages={[]}
              storeNotice={{
                kind: "not_saved",
                reason: "The conversation store is in a newer format than this version knows.",
              }}
              onEvent={setEvent}
            />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="The conversations list" tall>
            <AssistantListDemo initialItems={sampleConversations} onEvent={setEvent} />
          </AssistantPaneFrame>
          <AssistantPaneFrame title="No conversations yet">
            <AssistantListDemo initialItems={[]} onEvent={setEvent} />
          </AssistantPaneFrame>
        </div>
        <p className="ui text-text-muted">Last event: {event}</p>
      </Section>
    </>
  );
}
