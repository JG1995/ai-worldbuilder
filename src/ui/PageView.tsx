import { type ReactNode, useEffect, useState } from "react";
import { Button } from "./Button";

const loadingDelay = 300;

type PageViewProps = {
  title: string;
  /** Full-width notices above the title, such as `Notice` elements. */
  notices?: ReactNode;
  /** After 300ms of loading, the title shows with a "Loading…" line in place of the body. */
  loading?: boolean;
  children?: ReactNode;
};

/**
 * One page on the `page` ground: notices across the full width, then the read-only title and the
 * body in a centred column of at most the reading measure. Its side padding narrows when the pane,
 * not the window, is under 960px wide.
 */
export function PageView({ title, notices, loading = false, children }: PageViewProps) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSlow(true), loadingDelay);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [loading]);

  return (
    <div className="@container h-full overflow-y-auto bg-page">
      {notices && <div className="flex flex-col">{notices}</div>}
      <div className="px-page-x-narrow pt-3xl pb-12 @wide:px-page-x">
        {(!loading || slow) && (
          <article className="body mx-auto flex max-w-reading-measure flex-col gap-6 text-text">
            <h1 className="page-title break-words">{title}</h1>
            {loading ? <p className="text-text-muted">Loading…</p> : children}
          </article>
        )}
      </div>
    </div>
  );
}

/** The page region when no page is open. */
export function NoPageOpen({ onNewPage }: { onNewPage: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-page px-page-x-narrow">
      <p className="ui text-text-muted">No page is open.</p>
      <Button variant="secondary" onClick={onNewPage}>
        New page
      </Button>
    </div>
  );
}
