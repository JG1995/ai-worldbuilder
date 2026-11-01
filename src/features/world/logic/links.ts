import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { type RefObject, useEffect, useRef } from "react";
import type { IpcError } from "@/lib/ipc";
import type { EditorLink, EditorLinks, LinkedPage } from "@/types/api";
import { findAnchor, type LinkAnchor, setLinks } from "@/ui/editor-links";
import { linkCreate, linksIn } from "../api/commands";
import { useWorldStore } from "../stores/world-store";

/** How long after the last change to a page's text its links are asked for again. */
export const linkRequestDelay = 150;

/** The toast when creating a page from a link is refused for where the link points. */
export const outsideWorldToast = "This link does not point to a page in this world.";

/**
 * Asks the core for the links of one page's editor and gives them to it. An answer applies only
 * while the editor still has the text it was asked for and no later request has started, so an
 * answer that arrives late never marks the wrong text.
 */
export class LinkRequests {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest = 0;

  constructor(
    private readonly path: string,
    private readonly editor: () => EditorView | null,
    private readonly ask: (path: string, text: string) => Promise<EditorLinks> = linksIn,
  ) {}

  /** Asks again once the text has not changed for `linkRequestDelay`. */
  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.now(), linkRequestDelay);
  }

  /** Asks now, for the editor's text as it is. */
  now() {
    clearTimeout(this.timer);
    const view = this.editor();
    if (!view) return;
    const doc = view.state.doc;
    const request = ++this.latest;
    this.ask(this.path, doc.toString()).then(
      (answer) => {
        const current = this.editor();
        if (request !== this.latest || current?.state.doc !== doc) return;
        // While the index is being built, links show no styling.
        current.dispatch({ effects: setLinks(answer.state === "ready" ? answer.links : []) });
      },
      // The marks stay as they are; the next change or index change asks again.
      () => {},
    );
  }

  /** Stops asking, and drops any answer still on its way. */
  dispose() {
    clearTimeout(this.timer);
    this.latest++;
  }
}

/**
 * Asks the open suggestion list of `editor`, if any, again, so that it shows what the index holds
 * now: the pages that outside changes added or removed, and no "Indexing world…" once it is built.
 */
function refreshSuggestions(editor: EditorView | null) {
  if (editor && completionStatus(editor.state) === "active") startCompletion(editor);
}

/**
 * Keeps the links of the page at `path` current in its running editor, which `view` holds while
 * the page is ready: asked for when the editor mounts and whenever the world's index changes, when
 * an open suggestion list is asked again too. The editor reports its own changes through the
 * returned `changed`, and a state put in it, as after a reload, through `replaced`.
 */
export function usePageLinks(path: string, view: RefObject<EditorView | null> | undefined) {
  const indexRevision = useWorldStore((store) => store.indexRevision);
  const requests = useRef<LinkRequests | null>(null);

  useEffect(() => {
    if (!view) return;
    const current = new LinkRequests(path, () => view.current);
    requests.current = current;
    return () => {
      current.dispose();
      if (requests.current === current) requests.current = null;
    };
  }, [path, view]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new index revision asks again.
  useEffect(() => {
    requests.current?.now();
    refreshSuggestions(view?.current ?? null);
  }, [path, view, indexRevision]);

  return {
    changed: () => requests.current?.changed(),
    replaced: () => requests.current?.now(),
  };
}

/** What following a link can do besides moving the cursor in its own page. */
type FollowActions = {
  /** Opens the page at `path`, or activates its tab, with the cursor at `at` if it is there. */
  open: (path: string, at: LinkAnchor) => void;
  /** Creates the page an unresolved link names. */
  create: (link: EditorLink) => void;
};

/**
 * Follows `link` in the page at `path`, whose running editor is `view`. A resolved link to that
 * page moves its cursor to the link's heading or block; one to another page opens it; an
 * unresolved link creates its page; an attachment does nothing.
 */
export function followLink(
  path: string,
  link: EditorLink,
  view: EditorView | null,
  actions: FollowActions,
) {
  if (link.state === "unresolved") {
    actions.create(link);
    return;
  }
  if (link.state !== "resolved" || link.path === null) return;
  if (link.path !== path) {
    actions.open(link.path, { heading: link.heading, block: link.block });
    return;
  }
  if (!view) return;
  const at = findAnchor(view.state, link);
  if (at !== null) view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  view.focus();
}

/** What creating a page from a link does once the core has answered. */
type CreatePorts = {
  /** Lists the world's pages again, so the tree shows the new page. */
  refreshTree: () => Promise<unknown>;
  /** Opens a page that the link names by now in a new tab, with the cursor at `at`. */
  open: (path: string, at: LinkAnchor) => void;
};

/**
 * Creates the page that `link`, unresolved in the page at `from`, names, after saving that page,
 * and opens it with its editor focused. A page the link names by now opens instead, and nothing
 * happens while the index is being built. A refusal shows why.
 */
export async function createFromLink(
  session: number,
  from: string,
  link: EditorLink,
  ports: CreatePorts,
) {
  await useWorldStore.getState().flush(from);
  let linked: LinkedPage;
  try {
    linked = await linkCreate(from, link.target);
  } catch (error) {
    reportCreateFailure(session, error as IpcError);
    return;
  }
  if (useWorldStore.getState().world?.session !== session) return;
  if (linked.state === "existing") {
    ports.open(linked.path, { heading: link.heading, block: link.block });
  } else if (linked.state === "created") {
    await ports.refreshTree();
    if (useWorldStore.getState().world?.session === session) {
      useWorldStore.getState().pageCreated(linked.path);
    }
  }
}

function reportCreateFailure(session: number, { kind, message }: IpcError) {
  const { showToast, showWorldNotice } = useWorldStore.getState();
  if (kind === "world_missing") showWorldNotice(session, "missing");
  // A naming rule's message names the rule, and a clash's says what is there.
  else if (kind === "invalid_name" || kind === "exists") showToast(session, message);
  else if (kind === "invalid_path") showToast(session, outsideWorldToast);
  else showToast(session, `The page could not be created: ${message}`);
}
