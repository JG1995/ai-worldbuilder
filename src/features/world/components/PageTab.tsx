import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { IpcError } from "@/lib/ipc";
import type { HistoryVersion } from "@/types/api";
import { Backlinks } from "@/ui/Backlinks";
import { Button } from "@/ui/Button";
import {
  createPageState,
  MarkdownEditor,
  reloadedState,
  replaceDocument,
  replaceState,
} from "@/ui/MarkdownEditor";
import { Notice } from "@/ui/Notice";
import { PageView } from "@/ui/PageView";
import {
  backlinksKey,
  backlinksList,
  historyRestore,
  historyUndo,
  pageRead,
  pageRestore,
  pageWrite,
  worldTreeKey,
} from "../api/commands";
import { reloadToast } from "../logic/outside-changes";
import {
  isReadOnlyNotice,
  PageSaver,
  type ReplaceEditor,
  type ReplaceResult,
  type SaveNotice,
} from "../logic/saving";
import { unreadablePage, useWorldStore } from "../stores/world-store";
import { pageNameOf } from "../utils/paths";
import { CompareView } from "./CompareView";
import { HistoryView, versionTime } from "./HistoryView";

const notUtf8Text =
  "This page is not UTF-8 text. It cannot be edited here and has not been changed.";

type PageTabProps = {
  path: string;
  /** The world session the page belongs to; its results are dropped once that world closes. */
  session: number;
  /** Closes the tab, saving first. */
  onClose: (path: string) => void;
  /** Closes the tab without saving, dropping the text. */
  onDiscard: (path: string) => void;
  /** Opens another page with the cursor at `at`, as a backlink row asks. */
  onOpenPage: (path: string, options: { newTab: boolean; at: number }) => void;
};

/**
 * The pages that link to the page at `path`, asked of the index again whenever it changes. The
 * previous answer stays while the next one is on its way.
 */
function PageBacklinks({
  path,
  session,
  onOpenPage,
}: Pick<PageTabProps, "path" | "session" | "onOpenPage">) {
  const indexRevision = useWorldStore((store) => store.indexRevision);
  const backlinks = useQuery({
    queryKey: [...backlinksKey, session, path, indexRevision],
    queryFn: () => backlinksList(path),
    placeholderData: keepPreviousData,
  });
  const answer = backlinks.isError
    ? { state: "failed" as const, message: (backlinks.error as IpcError).message }
    : backlinks.data;
  if (!answer) return null;
  return (
    <Backlinks
      backlinks={answer}
      onOpen={(page, at, { newTab }) => onOpenPage(page, { newTab, at })}
    />
  );
}

/**
 * Passes a command's result on, and shows the missing-world notice when the core answers that the
 * world's folder is gone.
 */
function reportingMissingWorld<T>(session: number, command: Promise<T>) {
  return command.catch((error: IpcError) => {
    if (error.kind === "world_missing") {
      useWorldStore.getState().showWorldNotice(session, "missing");
    }
    throw error;
  });
}

/** The ready page at `path`, while it is open in the world `session`. */
function readyPage(session: number, path: string) {
  const { world, pages } = useWorldStore.getState();
  const page = pages[path];
  return world?.session === session && page?.status === "ready" ? page : null;
}

/**
 * Puts a page's text from a core write in its editor: in the running editor while its tab shows
 * the page, otherwise in the state the tab will show.
 */
function pageEditor(session: number, path: string): ReplaceEditor {
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
    reload: (text) => {
      const page = readyPage(session, path);
      if (!page) return false;
      const view = page.view?.current;
      const label = pageNameOf(path);
      if (view) replaceState(view, reloadedState(view.state, text, label));
      else setEditor(session, path, reloadedState(page.editor, text, label));
      return true;
    },
  };
}

/** Shows the reload toast when checking the page after a refused write reloaded it. */
function reportOutsideChange(session: number, result: ReplaceResult) {
  if (result.kind === "failed" && result.outside?.kind === "reloaded") {
    useWorldStore.getState().showToast(session, reloadToast);
  }
}

/**
 * Undoes a restore, the change `change` of the page at `path`: through the page's saver while it
 * is open, so the editor shows the text written back, and through the core alone otherwise. A
 * refused undo shows its reason as a toast.
 */
export async function undoChange(session: number, path: string, change: string) {
  const undo = () => reportingMissingWorld(session, historyUndo(change));
  const page = readyPage(session, path);
  if (!page) {
    await undo().catch((error: IpcError) => {
      useWorldStore.getState().showToast(session, error.message);
    });
    return;
  }
  const result = await page.saver.replacePage(undo, pageEditor(session, path));
  if (result.kind === "failed") useWorldStore.getState().showToast(session, result.error.message);
  reportOutsideChange(session, result);
  const { active, historyPath } = useWorldStore.getState();
  if (result.kind === "replaced" && active === path && historyPath !== path) {
    page.view?.current?.focus();
  }
}

/** One open page: it reads the page when it is loading and shows its editor or its notice. */
export function PageTab({ path, session, onClose, onDiscard, onOpenPage }: PageTabProps) {
  const page = useWorldStore((store) => store.pages[path]);
  const changingWorld = useWorldStore((store) => store.changingWorld);
  // Only a page the user just created, or switched to from another page's editor, takes focus, so
  // opening any other page leaves focus where it was.
  const focusEditor = useWorldStore((store) => store.createdPage === path);
  const showingHistory = useWorldStore((store) => store.historyPath === path);
  const { setPage, setEditor, setNotice, createdPageShown, showHistory, showToast } =
    useWorldStore.getState();
  const queryClient = useQueryClient();
  const [comparing, setComparing] = useState(false);
  const compareAction = useRef<HTMLButtonElement>(null);
  const title = pageNameOf(path);
  const loading = page?.status === "loading";
  const ready = page?.status === "ready";
  // Compare closes with its conflict, so a later conflict shows its notice until Compare is pressed.
  if (comparing && !(ready && page.notice?.kind === "conflict")) setComparing(false);

  // The editor has focused itself as it mounted, which runs before this effect. Its cursor, which
  // may be at a backlink's link, scrolls into view once React has settled the mounted editor.
  const editorView = ready ? page.view : undefined;
  useEffect(() => {
    if (!focusEditor || !editorView) return;
    createdPageShown();
    requestAnimationFrame(() => {
      const editor = editorView.current;
      editor?.dispatch({ effects: EditorView.scrollIntoView(editor.state.selection.main.head) });
    });
  }, [focusEditor, editorView, createdPageShown]);

  const backlinks = <PageBacklinks path={path} session={session} onOpenPage={onOpenPage} />;

  useEffect(() => {
    if (!loading) return;
    let current = true;
    reportingMissingWorld(session, pageRead(path)).then(
      (read) => {
        if (!current) return;
        const saver = new PageSaver(path, read, {
          read: (page) => reportingMissingWorld(session, pageRead(page)),
          write: (page, text, version, keepMine) =>
            reportingMissingWorld(session, pageWrite(page, text, version, keepMine)),
          notify: (notice) => setNotice(session, path, notice),
        });
        const at = useWorldStore.getState().takeCursorTarget(path) ?? 0;
        setPage(session, path, {
          status: "ready",
          editor: createPageState(read.text, title, Math.min(at, read.text.length)),
          view: { current: null },
          saver,
          notice: null,
        });
      },
      (error: IpcError) => {
        if (current) setPage(session, path, unreadablePage(error));
      },
    );
    return () => {
      current = false;
    };
  }, [path, session, title, loading, setPage, setNotice]);

  if (page?.status === "ready") {
    const { saver, notice, view } = page;
    /** Opens Compare and focuses its first action, because the pressed Compare button goes away. */
    const openCompare = () => {
      flushSync(() => setComparing(true));
      compareAction.current?.focus();
    };
    /**
     * Shows the editor again if Compare or the History view hid it, and focuses it: the button
     * that was pressed goes away.
     */
    const backToEditor = () => {
      flushSync(() => {
        setComparing(false);
        showHistory(null);
      });
      view?.current?.focus();
    };
    const keepMine = () => {
      backToEditor();
      void saver.keepMine();
    };
    const loadTheirs = () => {
      backToEditor();
      void saver.loadTheirs((text) => {
        // The tab may have stopped showing the page while its text was read.
        if (!view?.current) return false;
        replaceDocument(view.current, text);
        return true;
      });
    };
    const restore = async () => {
      backToEditor();
      const restored = await saver.restore((page, text) =>
        reportingMissingWorld(session, pageRestore(page, text)),
      );
      // The watcher leaves the application's own writes out, so the tree is refreshed here.
      if (restored) void queryClient.invalidateQueries({ queryKey: [...worldTreeKey, session] });
    };
    /**
     * Restores a version and returns to the editor with a toast, which offers Undo when history
     * recorded the restore. A refused write leaves the view open, with the reason unless the page
     * changed on disk, which the page's own notice or reload then shows.
     */
    const restoreVersion = async (version: HistoryVersion) => {
      const result = await saver.replacePage(
        (pageVersion) =>
          reportingMissingWorld(session, historyRestore(path, version.id, pageVersion)),
        pageEditor(session, path),
      );
      reportOutsideChange(session, result);
      if (result.kind === "failed" && result.error.kind !== "conflict") {
        return result.error.message;
      }
      if (result.kind !== "replaced") return null;
      backToEditor();
      const { change } = result.page;
      const undo =
        change === null
          ? undefined
          : { label: "Undo", run: () => void undoChange(session, path, change) };
      showToast(session, `Restored the version from ${versionTime(version.at)}`, undo);
      return null;
    };
    const hidden = comparing || showingHistory;
    return (
      <PageView
        title={title}
        notices={
          notice && (
            <SaveNoticeBar
              notice={notice}
              comparing={comparing}
              onRetry={() => saver.flush()}
              onKeepMine={keepMine}
              onLoadTheirs={loadTheirs}
              onCompare={openCompare}
              onRestore={() => void restore()}
              onDiscard={() => onDiscard(path)}
              onClose={() => onClose(path)}
            />
          )
        }
      >
        {comparing && (
          <CompareView
            firstActionRef={compareAction}
            path={path}
            text={saver.text()}
            onKeepMine={keepMine}
            onLoadTheirs={loadTheirs}
            onClose={backToEditor}
          />
        )}
        {showingHistory && !comparing && (
          <HistoryView
            path={path}
            saver={saver}
            restoreBlocked={notice !== null}
            onRestore={restoreVersion}
            onClose={backToEditor}
          />
        )}
        {/* Hidden, not unmounted, while Compare or History shows, so Load theirs, a restore and an
        undo can still replace its text in one undoable step. */}
        <div hidden={hidden}>
          <MarkdownEditor
            state={page.editor}
            readOnly={changingWorld || isReadOnlyNotice(notice)}
            autoFocus={focusEditor}
            viewRef={view}
            onChange={(editor) => saver.changed(editor.doc)}
            onUnmount={(editor) => setEditor(session, path, editor)}
          />
        </div>
        {!hidden && backlinks}
      </PageView>
    );
  }
  if (page?.status === "not_utf8") {
    return (
      <PageView title={title} notices={<Notice status="warning">{notUtf8Text}</Notice>}>
        {backlinks}
      </PageView>
    );
  }
  if (page?.status === "read_error") {
    return (
      <PageView
        title={title}
        notices={<ReadErrorNotice message={page.message} onClose={() => onClose(path)} />}
      />
    );
  }
  return <PageView title={title} loading />;
}

function ReadErrorNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <Notice
      status="error"
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      The page cannot be read: {message}
    </Notice>
  );
}

type SaveNoticeBarProps = {
  notice: SaveNotice;
  /** Compare shows the conflict's actions itself while it is open. */
  comparing: boolean;
  onRetry: () => void;
  onKeepMine: () => void;
  onLoadTheirs: () => void;
  onCompare: () => void;
  onRestore: () => void;
  /** Closes the tab without saving, dropping the text. */
  onDiscard: () => void;
  /** Closes the tab, saving first. */
  onClose: () => void;
};

function SaveNoticeBar({
  notice,
  comparing,
  onRetry,
  onKeepMine,
  onLoadTheirs,
  onCompare,
  onRestore,
  onDiscard,
  onClose,
}: SaveNoticeBarProps) {
  switch (notice.kind) {
    case "failed":
      return (
        <Notice
          status="error"
          actions={
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          This page could not be saved: {notice.reason}
        </Notice>
      );
    case "conflict":
      return (
        <Notice
          status="warning"
          actions={
            !comparing && (
              <>
                <Button variant="secondary" onClick={onKeepMine}>
                  Keep mine
                </Button>
                <Button variant="ghost" onClick={onLoadTheirs}>
                  Load theirs
                </Button>
                <Button variant="ghost" onClick={onCompare}>
                  Compare
                </Button>
              </>
            )
          }
        >
          This page changed on disk while it had unsaved edits.
        </Notice>
      );
    case "missing":
      return (
        <Notice
          status="error"
          actions={
            <>
              <Button variant="secondary" onClick={onRestore}>
                Restore
              </Button>
              <Button variant="ghost" onClick={onDiscard}>
                Close
              </Button>
            </>
          }
        >
          This page was deleted or moved outside Grimoire.md.
        </Notice>
      );
    case "not_utf8":
      return <Notice status="warning">{notUtf8Text}</Notice>;
    case "unreadable":
      return <ReadErrorNotice message={notice.message} onClose={onClose} />;
  }
}
