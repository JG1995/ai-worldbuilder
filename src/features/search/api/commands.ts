import { invokeCommand } from "@/lib/ipc";
import type { LinkedPage, PageMatches, TextMatches } from "@/types/api";

/**
 * Up to 10 pages whose name, alias or, for a query with a `/`, path from the world's root holds
 * `query`, ignoring letter case and accents, best first, with the matched characters; or whether the
 * world's page index is still being built, with the matches among the pages it has read so far, or
 * cannot be built. Rejects with `io` when the index's storage reports an error.
 */
export const searchPages = (query: string) => invokeCommand<PageMatches>("search_pages", { query });

/**
 * The TanStack Query key prefix of `search_pages` results; each adds the session, the trimmed query
 * and the index revision it was asked at.
 */
export const searchPagesKey = ["search_pages"] as const;

/**
 * Up to 10 pages whose saved text holds every word of `query`, each as the start of one of its
 * words, ignoring letter case and accents, most relevant first, leaving out the pages
 * `searchPages` lists for it. Each comes with its first 3 lines that hold a match, the matched
 * words marked, and where each line's first match starts in the page's text. While the index is
 * built, the matches among the pages it has read so far. Rejects as `searchPages` does.
 */
export const searchText = (query: string) => invokeCommand<TextMatches>("search_text", { query });

/**
 * The TanStack Query key prefix of `search_text` results; each adds the session, the trimmed query
 * and the index revision it was asked at.
 */
export const searchTextKey = ["search_text"] as const;

/**
 * Creates an empty page for `query`: `{query}.md` in the folder of the page at `from`, or at the
 * world's top level when `from` is null, or the page at the query's path from the top level when it
 * holds a `/`, with any missing folders. Returns `existing` for a page there in another letter case
 * and `not_ready` while the index is being built. Rejects with `invalid_name` or `exists`, whose
 * message names the broken rule, with `invalid_path` for a place the page cannot be created at, and
 * with `world_missing` when the world's folder is gone.
 */
export const searchCreate = (from: string | null, query: string) =>
  invokeCommand<LinkedPage>("search_create", { from, query });
