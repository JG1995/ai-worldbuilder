import { type ReactNode, useState } from "react";
import { Button } from "@/ui/Button";
import { type Tab, TabStrip } from "@/ui/TabStrip";
import { sampleLongTabs, sampleManyTabs, sampleTabs } from "./sample-data";

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

/** The tab strip's demos, and where the shell is composed. Their demos keep local state. */
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
        title="Shell"
        use="The tree pane and the page region side by side from 960px, and the tree as an overlay below. F6 moves between the panes."
      >
        <p className="ui text-text">
          The shell composes the other surfaces in the{" "}
          <a href="#sample-world" className="text-accent underline">
            sample world screen
          </a>
          .
        </p>
      </Section>
    </>
  );
}
