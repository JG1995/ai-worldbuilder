import { type KeyboardEvent, type MouseEvent, useId } from "react";
import type { Backlink, Backlinks as BacklinksState } from "@/types/api";
import { Icon } from "./Icon";

type BacklinksProps = {
  backlinks: BacklinksState;
  /**
   * Opens a linking page with the cursor at `at`, its first link here (in UTF-16 code units): in
   * the current tab, or in a new tab for Ctrl/Cmd+click, a middle click or Ctrl/Cmd+Enter.
   */
  onOpen: (path: string, at: number, options: { newTab: boolean }) => void;
};

/** The "Linked from" section below a page: the pages that link to it, or why they cannot show. */
export function Backlinks({ backlinks, onOpen }: BacklinksProps) {
  const headingId = useId();
  const count = backlinks.state === "ready" ? backlinks.pages.length : null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="label-caps flex gap-2 text-text-muted">
        Linked from{count !== null && <span>{count}</span>}
      </h2>
      {backlinks.state === "building" && (
        <p className="ui flex items-center gap-1 text-info">
          <Icon name="info" />
          Indexing world…
        </p>
      )}
      {backlinks.state === "failed" && (
        <p className="ui flex items-start gap-1 text-text">
          <span className="flex pt-0.5 text-error">
            <Icon name="error" />
          </span>
          <span className="min-w-0">Backlinks cannot be shown: {backlinks.message}</span>
        </p>
      )}
      {backlinks.state === "ready" &&
        (backlinks.pages.length === 0 ? (
          <p className="ui text-text-muted">No pages link here yet.</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {backlinks.pages.map((page) => (
              <li key={page.path}>
                <BacklinkRow
                  page={page}
                  showFolder={backlinks.pages.some(
                    (other) =>
                      other !== page && other.name.toLowerCase() === page.name.toLowerCase(),
                  )}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

type BacklinkRowProps = {
  page: Backlink;
  /** Another row has the same name, so this one shows its folder. */
  showFolder: boolean;
  onOpen: BacklinksProps["onOpen"];
};

function BacklinkRow({ page, showFolder, onOpen }: BacklinkRowProps) {
  const folder = page.path.slice(0, Math.max(page.path.lastIndexOf("/"), 0));
  const open = (newTab: boolean) => onOpen(page.path, page.at, { newTab });

  return (
    <button
      type="button"
      onClick={(event: MouseEvent) => open(event.ctrlKey || event.metaKey)}
      onAuxClick={(event) => event.button === 1 && open(true)}
      // A middle press would otherwise start the browser's autoscroll.
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        open(event.ctrlKey || event.metaKey);
      }}
      className="flex w-full min-w-0 flex-col items-start rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-hover"
    >
      <span className="flex max-w-full items-baseline gap-2">
        <span className="ui-strong truncate text-text">{page.name}</span>
        {showFolder && folder && (
          <span className="ui-small truncate text-text-muted">{folder}</span>
        )}
      </span>
      <span className="ui-small max-w-full truncate text-text-muted">{page.line}</span>
    </button>
  );
}
