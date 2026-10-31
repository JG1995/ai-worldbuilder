import type { QueryClient } from "@tanstack/react-query";
import { listenEvent } from "@/lib/ipc";
import type { WorldEvents } from "@/types/api";
import { reloadedState, replaceState } from "@/ui/MarkdownEditor";
import { worldTreeKey } from "../api/commands";
import { unreadablePage, useWorldStore } from "../stores/world-store";
import { pageNameOf } from "../utils/paths";
import type { OutsideChange } from "./saving";

/** The toast a batch of outside changes shows when it reloaded at least one page. */
export const reloadToast = "Reloaded: changed outside Grimoire.md";

type WorldEvent = {
  [Name in keyof WorldEvents]: { name: Name; payload: WorldEvents[Name] };
}[keyof WorldEvents];

/**
 * Follows the watcher's and the world history's events until the returned function is called. An
 * event for the open world refreshes the tree, checks its open pages, or shows or hides a
 * world-level notice; an event from a world that is no longer open is ignored. The core sends an
 * opening's first events, such as a watcher that could not start or a history that cannot record,
 * while it opens the world, so they can arrive before the interface knows the new session: those
 * wait until that world opens here.
 */
export function followOutsideChanges(queryClient: QueryClient): () => void {
  /** The session of the latest world opened here; later sessions are still opening. */
  let latest = useWorldStore.getState().world?.session ?? 0;
  let early: WorldEvent[] = [];

  function receive(event: WorldEvent) {
    const { session } = event.payload;
    if (session > latest) early.push(event);
    else if (session === useWorldStore.getState().world?.session) void apply(event);
  }

  function apply(event: WorldEvent) {
    const { showWorldNotice, setHistoryNotRecording } = useWorldStore.getState();
    switch (event.name) {
      case "world:changed":
        return changed(queryClient, event.payload);
      case "world:missing":
        return showWorldNotice(event.payload.session, "missing");
      case "world:watch-failed":
        return showWorldNotice(event.payload.session, "watch_failed");
      case "world:history-not-recording":
        return setHistoryNotRecording(event.payload.session, event.payload.message);
      case "world:history-recording":
        return setHistoryNotRecording(event.payload.session, null);
      case "world:history-set-aside":
        return showWorldNotice(event.payload.session, "history_set_aside");
    }
  }

  const stopFollowingStore = useWorldStore.subscribe(({ world }, previous) => {
    if (!world || world === previous.world) return;
    latest = world.session;
    const due = early.filter((event) => event.payload.session === latest);
    early = early.filter((event) => event.payload.session > latest);
    for (const event of due) void apply(event);
  });

  const unlisteners = [
    listenEvent<WorldEvents["world:changed"]>("world:changed", (payload) =>
      receive({ name: "world:changed", payload }),
    ),
    listenEvent<WorldEvents["world:missing"]>("world:missing", (payload) =>
      receive({ name: "world:missing", payload }),
    ),
    listenEvent<WorldEvents["world:watch-failed"]>("world:watch-failed", (payload) =>
      receive({ name: "world:watch-failed", payload }),
    ),
    listenEvent<WorldEvents["world:history-not-recording"]>(
      "world:history-not-recording",
      (payload) => receive({ name: "world:history-not-recording", payload }),
    ),
    listenEvent<WorldEvents["world:history-recording"]>("world:history-recording", (payload) =>
      receive({ name: "world:history-recording", payload }),
    ),
    listenEvent<WorldEvents["world:history-set-aside"]>("world:history-set-aside", (payload) =>
      receive({ name: "world:history-set-aside", payload }),
    ),
  ];

  return () => {
    stopFollowingStore();
    for (const unlisten of unlisteners) unlisten();
  };
}

/** Refreshes the tree if it changed, and checks each open page that changed, with one toast. */
async function changed(
  queryClient: QueryClient,
  { session, tree, pages }: WorldEvents["world:changed"],
) {
  if (tree) void queryClient.invalidateQueries({ queryKey: [...worldTreeKey, session] });
  const open = pages.filter((path) => Object.hasOwn(useWorldStore.getState().pages, path));
  const results = await Promise.all(open.map((path) => pageChanged(session, path)));
  if (results.includes("reloaded")) useWorldStore.getState().showToast(session, reloadToast);
}

/** Checks one open page after it changed on disk. */
async function pageChanged(session: number, path: string): Promise<OutsideChange["kind"]> {
  const page = useWorldStore.getState().pages[path];
  // A page shown without an editor is read again when its tab shows it.
  if (page?.status === "not_utf8" || page?.status === "read_error") {
    useWorldStore.getState().setPage(session, path, { status: "loading" });
    return "unchanged";
  }
  // A page still loading is being read now.
  if (page?.status !== "ready") return "unchanged";

  const result = await page.saver.outsideChange((text) => reload(session, path, text));
  const { pages, setPage, showWorldNotice } = useWorldStore.getState();
  if (result.kind === "world_missing") showWorldNotice(session, "missing");
  const current = pages[path];
  if (result.kind === "unreadable" && current?.status === "ready" && current.saver === page.saver) {
    page.saver.dispose();
    setPage(session, path, unreadablePage(result.error));
  }
  return result.kind;
}

/**
 * Puts the page's new text in its editor as a fresh state, with no undo history and the cursor
 * where it was: in the running editor while the tab shows the page, otherwise in the state the
 * tab will show. False when the page is no longer open in that world.
 */
function reload(session: number, path: string, text: string) {
  const { world, pages, setEditor } = useWorldStore.getState();
  const page = pages[path];
  if (world?.session !== session || page?.status !== "ready") return false;
  const label = pageNameOf(path);
  const view = page.view?.current;
  if (view) replaceState(view, reloadedState(view.state, text, label));
  else setEditor(session, path, reloadedState(page.editor, text, label));
  return true;
}
