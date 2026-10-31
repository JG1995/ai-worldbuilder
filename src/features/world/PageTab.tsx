import { useEffect } from "react";
import type { IpcError } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Notice";
import { PageView } from "../../ui/PageView";
import { createPageState, MarkdownEditor } from "../editor/MarkdownEditor";
import { pageRead } from "./commands";
import { pageNameOf, useWorldStore } from "./store";

/** One open page: it reads the page when it is loading and shows its editor or its notice. */
export function PageTab({ path }: { path: string }) {
  const page = useWorldStore((store) => store.pages[path]);
  const setPage = useWorldStore((store) => store.setPage);
  const closeTab = useWorldStore((store) => store.closeTab);
  const title = pageNameOf(path);
  const loading = page?.status === "loading";

  useEffect(() => {
    if (!loading) return;
    let current = true;
    pageRead(path).then(
      ({ text, version }) =>
        current &&
        setPage(path, { status: "ready", version, editor: createPageState(text, title) }),
      (error: IpcError) => {
        if (!current) return;
        setPage(
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
  }, [path, title, loading, setPage]);

  if (page?.status === "ready") {
    return (
      <PageView title={title}>
        <MarkdownEditor
          state={page.editor}
          readOnly
          onUnmount={(editor) => editor !== page.editor && setPage(path, { ...page, editor })}
        />
      </PageView>
    );
  }
  if (page?.status === "not_utf8") {
    return (
      <PageView
        title={title}
        notices={
          <Notice status="warning">
            This page is not UTF-8 text. It cannot be edited here and has not been changed.
          </Notice>
        }
      />
    );
  }
  if (page?.status === "read_error") {
    return (
      <PageView
        title={title}
        notices={
          <Notice
            status="error"
            actions={
              <Button variant="ghost" onClick={() => closeTab(path)}>
                Close
              </Button>
            }
          >
            The page cannot be read: {page.message}
          </Notice>
        }
      />
    );
  }
  return <PageView title={title} loading />;
}
