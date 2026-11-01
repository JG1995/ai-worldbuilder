import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import { SearchDialog, type SearchPick, type SearchResults } from "@/ui/SearchDialog";
import { searchCreate, searchPages, searchPagesKey } from "../api/commands";

export type QuickOpenProps = {
  /** The open world's session, which keys its results. */
  session: number;
  /** The active page, whose folder a new page goes in; null with no page open. */
  activePage: string | null;
  /** Changes whenever the world's page index changes, so the results are asked for again. */
  indexRevision: number;
  /** Opens a page by the tab rules, with focus in its editor; `at` puts the cursor there. */
  openPage: (path: string, options: { newTab: boolean; at?: number }) => void;
  /** Opens a page just created in a new tab, with focus in its empty editor. */
  pageCreated: (path: string) => void;
  /** Lists the world's tree again, as after a creation that may have left folders. */
  refreshTree: () => void;
  /** Shows that the world's folder cannot be found. */
  showWorldMissing: () => void;
  /** Hides the dialog. */
  close: () => void;
};

/** What a refused creation says under the input. */
function createErrorOf({ kind, message }: IpcError) {
  if (kind === "invalid_name" || kind === "exists") return message;
  if (kind === "invalid_path") return "The page cannot be created there.";
  return `The page could not be created: ${message}`;
}

/**
 * Quick open: the search dialog for the open world's pages. It asks the core for the pages that
 * match the query, offers to create the page when none matches by name, alias or path once the
 * index is built, and opens what the user picks through its props.
 */
export function QuickOpen({
  session,
  activePage,
  indexRevision,
  openPage,
  pageCreated,
  refreshTree,
  showWorldMissing,
  close,
}: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [createError, setCreateError] = useState<string>();
  const creating = useRef(false);
  const trimmed = query.trim();
  // Each answer carries the query it is for, so an answer kept while the next one loads is shown
  // for its own query; an answer to an older query never replaces the current one's.
  const answer = useQuery({
    queryKey: [...searchPagesKey, session, trimmed, indexRevision],
    queryFn: async () => ({ query: trimmed, matches: await searchPages(trimmed) }),
    enabled: trimmed !== "",
    placeholderData: keepPreviousData,
  });
  const shown = trimmed === "" ? undefined : answer.data;
  const failure = trimmed !== "" && answer.isError ? (answer.error as IpcError) : null;

  const results = useMemo((): SearchResults | null => {
    if (failure) return { state: "failed", query: trimmed, message: failure.message };
    if (!shown) return null;
    const { query: answered, matches } = shown;
    if (matches.state === "failed") {
      return { state: "failed", query: answered, message: matches.message };
    }
    // Only an answer for the query as typed now, from a built index, offers to create the page.
    const create = matches.state === "ready" && matches.pages.length === 0 && answered === trimmed;
    return { state: matches.state, query: answered, pages: matches.pages, create };
  }, [failure, shown, trimmed]);

  async function create() {
    if (creating.current) return;
    creating.current = true;
    try {
      const linked = await searchCreate(activePage, trimmed);
      if (linked.state === "created") {
        close();
        pageCreated(linked.path);
      } else if (linked.state === "existing") {
        close();
        openPage(linked.path, { newTab: true });
      }
    } catch (error) {
      // Folders created before a failure stay, so the tree is listed again.
      refreshTree();
      if ((error as IpcError).kind === "world_missing") {
        close();
        showWorldMissing();
      } else {
        setCreateError(createErrorOf(error as IpcError));
      }
    } finally {
      creating.current = false;
    }
  }

  function pick(picked: SearchPick, { newTab }: { newTab: boolean }) {
    if (picked.kind === "create") {
      void create();
      return;
    }
    close();
    openPage(picked.path, { newTab });
  }

  return (
    <SearchDialog
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setCreateError(undefined);
      }}
      results={results}
      createError={createError}
      onPick={pick}
      onClose={close}
    />
  );
}
