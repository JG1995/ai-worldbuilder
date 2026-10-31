import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { IpcError } from "@/lib/ipc";
import { Button } from "@/ui/Button";
import { createPageState, MarkdownEditor, replaceDocument } from "@/ui/MarkdownEditor";
import { Notice } from "@/ui/Notice";
import { PageView } from "@/ui/PageView";
import { pageRead, pageRestore, pageWrite, worldTreeKey } from "../api/commands";
import { isReadOnlyNotice, PageSaver, type SaveNotice } from "../logic/saving";
import { unreadablePage, useWorldStore } from "../stores/world-store";
import { pageNameOf } from "../utils/paths";
import { CompareView } from "./CompareView";

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
};

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

/** One open page: it reads the page when it is loading and shows its editor or its notice. */
export function PageTab({ path, session, onClose, onDiscard }: PageTabProps) {
  const page = useWorldStore((store) => store.pages[path]);
  const changingWorld = useWorldStore((store) => store.changingWorld);
  // Only a page the user just created, or switched to from another page's editor, takes focus, so
  // opening any other page leaves focus where it was.
  const focusEditor = useWorldStore((store) => store.createdPage === path);
  const { setPage, setEditor, setNotice, createdPageShown } = useWorldStore.getState();
  const queryClient = useQueryClient();
  const [comparing, setComparing] = useState(false);
  const compareAction = useRef<HTMLButtonElement>(null);
  const title = pageNameOf(path);
  const loading = page?.status === "loading";
  const ready = page?.status === "ready";
  // Compare closes with its conflict, so a later conflict shows its notice until Compare is pressed.
  if (comparing && !(ready && page.notice?.kind === "conflict")) setComparing(false);

  // The editor has focused itself as it mounted, which runs before this effect.
  useEffect(() => {
    if (ready && focusEditor) createdPageShown();
  }, [ready, focusEditor, createdPageShown]);

  useEffect(() => {
    if (!loading) return;
    let current = true;
    reportingMissingWorld(session, pageRead(path)).then(
      (read) => {
        if (!current) return;
        const saver = new PageSaver(path, read, {
          read: (page) => reportingMissingWorld(session, pageRead(page)),
          write: (page, text, version) =>
            reportingMissingWorld(session, pageWrite(page, text, version)),
          notify: (notice) => setNotice(session, path, notice),
        });
        setPage(session, path, {
          status: "ready",
          editor: createPageState(read.text, title),
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
     * Shows the editor again if Compare hid it, and focuses it: the notice or Compare button that
     * was pressed goes away with the notice.
     */
    const backToEditor = () => {
      flushSync(() => setComparing(false));
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
        {/* Hidden, not unmounted, while Compare shows, so Load theirs can still replace its text. */}
        <div hidden={comparing}>
          <MarkdownEditor
            state={page.editor}
            readOnly={changingWorld || isReadOnlyNotice(notice)}
            autoFocus={focusEditor}
            viewRef={view}
            onChange={(editor) => saver.changed(editor.doc)}
            onUnmount={(editor) => setEditor(session, path, editor)}
          />
        </div>
      </PageView>
    );
  }
  if (page?.status === "not_utf8") {
    return <PageView title={title} notices={<Notice status="warning">{notUtf8Text}</Notice>} />;
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
