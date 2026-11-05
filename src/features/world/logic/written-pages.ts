import { isolateHistory } from "@codemirror/commands";
import type { WrittenPage } from "@/types/api";
import { replaceDocument } from "@/ui/MarkdownEditor";
import { useWorldStore } from "../stores/world-store";
import { reloadPage } from "./outside-changes";
import type { ReplaceEditor } from "./saving";

/** The ready page at `path`, while it is open in the world `session`. */
export function readyPage(session: number, path: string) {
  const { world, pages } = useWorldStore.getState();
  const page = pages[path];
  return world?.session === session && page?.status === "ready" ? page : null;
}

/**
 * Puts a page's text from a core write in its editor: in the running editor while its tab shows
 * the page, otherwise in the state the tab will show.
 */
export function pageEditor(session: number, path: string): ReplaceEditor {
  const { setEditor } = useWorldStore.getState();
  return {
    replace: (text) => {
      const page = readyPage(session, path);
      const view = page?.view?.current;
      if (view) replaceDocument(view, text);
      else if (page) {
        const { editor } = page;
        const changes = { from: 0, to: editor.doc.length, insert: text };
        setEditor(
          session,
          path,
          editor.update({ changes, annotations: isolateHistory.of("full") }).state,
        );
      }
    },
    // As after an outside change: a fresh state with the cursor kept and no undo history.
    reload: (text) => reloadPage(session, path, text),
  };
}

/** Saves the open pages among `paths`; false when any of them could not be saved. */
export async function flushPages(paths: string[]) {
  const { flush } = useWorldStore.getState();
  const results = await Promise.all(paths.map((path) => flush(path)));
  return results.every(({ kind }) => kind === "saved" || kind === "clean");
}

/**
 * Puts pages a core write wrote in the open world `session` in their open tabs, then refreshes the
 * tree and, with `flash`, flashes their rows.
 */
export async function pagesWritten(
  session: number,
  pages: WrittenPage[],
  { flash, refreshTree }: { flash: boolean; refreshTree: () => Promise<unknown> },
) {
  await Promise.all(
    pages.map(async ({ path, text, version }) => {
      const page = useWorldStore.getState().pages[path];
      if (page?.status === "ready") {
        await page.saver.adoptWritten({ text, version }, pageEditor(session, path));
      }
    }),
  );
  // The watcher leaves the application's own writes out, so the tree is refreshed here, and
  // new pages' rows can flash only once it lists them.
  await refreshTree();
  if (!flash) return;
  useWorldStore.getState().flashRows(
    session,
    pages.map((page) => page.path),
  );
}

/** Closes the tabs of pages a core write deleted that hold no unsaved text, then refreshes the tree. */
export async function pagesDeleted(
  paths: string[],
  { refreshTree }: { refreshTree: () => Promise<unknown> },
) {
  await Promise.all(
    paths.map(async (path) => {
      const page = useWorldStore.getState().pages[path];
      if (page === undefined) return;
      if (page.status === "ready" && !(await page.saver.pageDeleted())) return;
      // Unless the tab closed or opened the page again meanwhile.
      if (useWorldStore.getState().pages[path] === page) useWorldStore.getState().closeTab(path);
    }),
  );
  await refreshTree();
}
