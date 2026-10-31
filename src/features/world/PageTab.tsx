import type { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { IpcError } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Notice";
import { PageView } from "../../ui/PageView";
import { createPageState, MarkdownEditor, replaceDocument } from "../editor/MarkdownEditor";
import { pageRead, pageWrite } from "./commands";
import { isReadOnlyNotice, missingReason, PageSaver, type SaveNotice } from "./saving";
import { pageNameOf, useWorldStore } from "./store";

const notUtf8Text =
  "This page is not UTF-8 text. It cannot be edited here and has not been changed.";

type PageTabProps = {
  path: string;
  /** The world session the page belongs to; its results are dropped once that world closes. */
  session: number;
  /** Closes the tab, saving first. */
  onClose: (path: string) => void;
};

/** One open page: it reads the page when it is loading and shows its editor or its notice. */
export function PageTab({ path, session, onClose }: PageTabProps) {
  const page = useWorldStore((store) => store.pages[path]);
  const changingWorld = useWorldStore((store) => store.changingWorld);
  // Only a page the user just created takes focus, so opening any other page leaves focus where
  // it was.
  const justCreated = useWorldStore((store) => store.createdPage === path);
  const { setPage, setEditor, setNotice, createdPageShown } = useWorldStore.getState();
  const view = useRef<EditorView>(null);
  const title = pageNameOf(path);
  const loading = page?.status === "loading";
  const ready = page?.status === "ready";

  // The editor has focused itself as it mounted, which runs before this effect.
  useEffect(() => {
    if (ready && justCreated) createdPageShown();
  }, [ready, justCreated, createdPageShown]);

  useEffect(() => {
    if (!loading) return;
    let current = true;
    pageRead(path).then(
      (read) => {
        if (!current) return;
        const saver = new PageSaver(path, read, {
          read: pageRead,
          write: pageWrite,
          notify: (notice) => setNotice(session, path, notice),
        });
        setPage(session, path, {
          status: "ready",
          editor: createPageState(read.text, title),
          saver,
          notice: null,
        });
      },
      (error: IpcError) => {
        if (!current) return;
        setPage(
          session,
          path,
          error.kind === "not_utf8"
            ? { status: "not_utf8" }
            : { status: "read_error", message: error.message },
        );
      },
    );
    return () => {
      current = false;
    };
  }, [path, session, title, loading, setPage, setNotice]);

  if (page?.status === "ready") {
    const { saver, notice } = page;
    const loadTheirs = () =>
      saver.loadTheirs((text) => {
        // The tab may have stopped showing the page while its text was read.
        if (!view.current) return false;
        replaceDocument(view.current, text);
        return true;
      });
    return (
      <PageView
        title={title}
        notices={
          notice && (
            <SaveNoticeBar
              notice={notice}
              onRetry={() => saver.flush()}
              onKeepMine={() => saver.keepMine()}
              onLoadTheirs={loadTheirs}
              onClose={() => onClose(path)}
            />
          )
        }
      >
        <MarkdownEditor
          state={page.editor}
          readOnly={changingWorld || isReadOnlyNotice(notice)}
          autoFocus={justCreated}
          viewRef={view}
          onChange={(editor) => saver.changed(editor.doc)}
          onUnmount={(editor) => setEditor(session, path, editor)}
        />
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
  onRetry: () => void;
  onKeepMine: () => void;
  onLoadTheirs: () => void;
  onClose: () => void;
};

function SaveNoticeBar({ notice, onRetry, onKeepMine, onLoadTheirs, onClose }: SaveNoticeBarProps) {
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
            <>
              <Button variant="secondary" onClick={onKeepMine}>
                Keep mine
              </Button>
              <Button variant="ghost" onClick={onLoadTheirs}>
                Load theirs
              </Button>
            </>
          }
        >
          This page changed on disk while it had unsaved edits.
        </Notice>
      );
    case "missing":
      return <Notice status="error">This page could not be saved: {missingReason}</Notice>;
    case "not_utf8":
      return <Notice status="warning">{notUtf8Text}</Notice>;
    case "unreadable":
      return <ReadErrorNotice message={notice.message} onClose={onClose} />;
  }
}
