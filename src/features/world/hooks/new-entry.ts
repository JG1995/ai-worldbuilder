import { useRef } from "react";
import type { IpcError } from "@/lib/ipc";
import type { TreeNameInput } from "@/ui/FileTree";
import { folderCreate, pageCreate } from "../api/commands";
import { readingLayout, useWorldStore } from "../stores/world-store";

type NewEntryOptions = {
  /** The open world's session; a creation that ends after the world changed does nothing more. */
  session: number;
  /** Refreshes the tree, which then lists the new entry. */
  refreshTree: () => Promise<unknown>;
  /** Saves the active page, without a dialog, when the page at `path` is about to take its place. */
  flushActiveBefore: (path: string) => void;
};

/**
 * Creating a page or a folder through the tree's name input: `startNew` opens the input,
 * `cancelNew` closes it and `submitName` asks the core to create the entry. Focus goes back to
 * where it was when the input opened, unless a new page opens.
 */
export function useNewEntry({ session, refreshTree, flushActiveBefore }: NewEntryOptions) {
  /** Where focus was when the name input opened, to return it there when the input closes. */
  const focusBeforeNaming = useRef<Element | null>(null);
  const creating = useRef(false);
  const {
    newEntryFolder,
    startNaming,
    setNameError,
    cancelNaming,
    pageCreated,
    folderCreated,
    setTreeOverlayOpen,
    setReadingTreeOpen,
  } = useWorldStore.getState();

  /**
   * Opens the name input for a new page or folder in its target folder. From the page region
   * below 960px it opens the tree overlay; at 960px and wider the shell closes the overlay again.
   * In the reading layout it opens the collapsed tree.
   */
  function startNew(kind: TreeNameInput["kind"], rightClickedFolder?: string) {
    if (!useWorldStore.getState().nameInput) focusBeforeNaming.current = document.activeElement;
    startNaming(kind, newEntryFolder(rightClickedFolder));
    if (readingLayout(useWorldStore.getState())) setReadingTreeOpen(true);
    else setTreeOverlayOpen(true);
  }

  function returnFocusFromNaming() {
    const previous = focusBeforeNaming.current;
    focusBeforeNaming.current = null;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }

  function cancelNew() {
    returnFocusFromNaming();
    cancelNaming();
  }

  /** Asks the core to create the entry. Its errors keep the input open with their message. */
  async function submitName(name: string) {
    const request = useWorldStore.getState().nameInput;
    if (!request || creating.current) return;
    creating.current = true;
    try {
      const create = request.kind === "page" ? pageCreate : folderCreate;
      const { path } = await create(request.folder, name);
      await refreshTree();
      if (useWorldStore.getState().world?.session !== session) return;
      if (request.kind === "page") {
        focusBeforeNaming.current = null;
        flushActiveBefore(path);
        pageCreated(path);
        setTreeOverlayOpen(false);
      } else {
        returnFocusFromNaming();
        folderCreated(path);
      }
    } catch (error) {
      setNameError((error as IpcError).message);
    } finally {
      creating.current = false;
    }
  }

  return { startNew, cancelNew, submitName };
}
