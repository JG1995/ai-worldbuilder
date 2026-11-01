import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import { SearchDialog, type SearchPick, type SearchResults } from "@/ui/SearchDialog";
import {
  searchCreate,
  searchPages,
  searchPagesKey,
  searchText,
  searchTextKey,
} from "../api/commands";

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
 * match the query by name, alias or path, and apart from them for the pages whose text matches it,
 * offers to create the page when none matches by name, alias or path once the index is built, and
 * opens what the user picks through its props.
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
  // for its own query; an answer to an older query never replaces the current one's. The two
  // queries run apart, so page matches never wait for text matches.
  const answer = useQuery({
    queryKey: [...searchPagesKey, session, trimmed, indexRevision],
    queryFn: async () => ({ query: trimmed, matches: await searchPages(trimmed) }),
    enabled: trimmed !== "",
    placeholderData: keepPreviousData,
  });
  const textAnswer = useQuery({
    queryKey: [...searchTextKey, session, trimmed, indexRevision],
    queryFn: async () => ({ query: trimmed, matches: await searchText(trimmed) }),
    enabled: trimmed !== "",
    placeholderData: keepPreviousData,
  });
  const shown = trimmed === "" ? undefined : answer.data;
  // A failed text request adds no text matches and takes away no page match, which can still open.
  const textFailed = textAnswer.isError;
  const shownText = trimmed === "" || textFailed ? undefined : textAnswer.data;
  const failure = trimmed !== "" && answer.isError ? (answer.error as IpcError) : null;

  const results = useMemo((): SearchResults | null => {
    if (failure) return { state: "failed", query: trimmed, message: failure.message };
    if (!shown && !shownText) return null;
    for (const given of [shown, shownText]) {
      if (given?.matches.state === "failed") {
        return { state: "failed", query: given.query, message: given.matches.message };
      }
    }
    const pages = shown && "pages" in shown.matches ? shown.matches.pages : [];
    const texts = shownText && "pages" in shownText.matches ? shownText.matches.pages : [];
    const building = [shown, shownText].some((given) => given?.matches.state === "building");
    // Only an answer for the query as typed now, from a built index, offers to create the page.
    const create =
      shown?.matches.state === "ready" && pages.length === 0 && shown.query === trimmed;
    return {
      state: building ? "building" : "ready",
      query: shown?.query ?? shownText?.query ?? trimmed,
      pages,
      create,
      texts,
      // Nothing matches only once both answers for the query as typed now are in.
      pending: shown?.query !== trimmed || (!textFailed && shownText?.query !== trimmed),
    };
  }, [failure, shown, shownText, textFailed, trimmed]);

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
    if (picked.kind === "line") openPage(picked.path, { newTab, at: picked.at });
    else openPage(picked.path, { newTab });
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
