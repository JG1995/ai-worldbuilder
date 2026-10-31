import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { IpcError } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { WelcomeScreen } from "../../ui/WelcomeScreen";
import { worldClose, worldOpen, worldTreeKey } from "./commands";
import { useSaveConfirmation } from "./FailedSaveDialog";
import { useWorldStore } from "./store";
import { WorldScreen } from "./WorldScreen";

// New world and recent worlds arrive in later packages; until then their controls do nothing.
const notYet = () => {};

type Failure = { title: string; message: string };

/**
 * The welcome screen or the open world, and the flows that open and close worlds. Before the world
 * changes, every open page saves, with the failed-save dialog for each one that cannot.
 */
export function World() {
  const world = useWorldStore((store) => store.world);
  const changingWorld = useWorldStore((store) => store.changingWorld);
  const { opened, closed, setChangingWorld, holdSaving } = useWorldStore.getState();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<Failure | null>(null);
  const { confirmSaved, failedSaveDialog } = useSaveConfirmation();

  /** Saves every open page in tab order. False when the user cancels on a page that cannot save. */
  async function confirmAllSaved() {
    for (const path of useWorldStore.getState().tabs) {
      if (!(await confirmSaved(path))) return false;
    }
    return true;
  }

  /**
   * Runs `change` once every page has saved. One change runs at a time, and the world takes no
   * edits until it ends, so none can be made after its page saved and then dropped with its
   * editor. Autosave waits meanwhile, so no save meant for this world can reach the core after it
   * has switched to another; the store's `opened` and `closed` then stop this world's savers.
   */
  async function changeWorld(change: () => Promise<void>) {
    if (useWorldStore.getState().changingWorld) return;
    setChangingWorld(true);
    try {
      if (!(await confirmAllSaved())) return;
      const release = holdSaving();
      try {
        await change();
      } finally {
        release();
      }
    } finally {
      setChangingWorld(false);
    }
  }

  const openWorld = () =>
    changeWorld(async () => {
      try {
        const result = await worldOpen();
        if (!result) return;
        queryClient.removeQueries({ queryKey: worldTreeKey });
        opened(result);
      } catch (error) {
        setFailure({ title: "The folder cannot be opened", message: (error as IpcError).message });
      }
    });

  const closeWorld = () =>
    changeWorld(async () => {
      try {
        await worldClose();
      } catch (error) {
        setFailure({ title: "The world cannot be closed", message: (error as IpcError).message });
        return;
      }
      closed();
      queryClient.removeQueries({ queryKey: worldTreeKey });
    });

  const dismiss = () => setFailure(null);

  return (
    // Dialogs render in portals outside this element, so they still take input while it is inert.
    <div className="h-screen" inert={changingWorld}>
      {world ? (
        <WorldScreen
          key={world.session}
          session={world.session}
          worldName={world.name}
          onOpenWorld={openWorld}
          onCloseWorld={closeWorld}
        />
      ) : (
        <div className="relative h-full">
          <WelcomeScreen
            recentWorlds={[]}
            onOpenWorld={openWorld}
            onNewWorld={notYet}
            onChooseRecent={notYet}
            onRemoveRecent={notYet}
          />
          {import.meta.env.DEV && (
            <a href="/showcase.html" className="ui absolute top-3 right-4 text-accent underline">
              Showcase
            </a>
          )}
        </div>
      )}
      {failure && (
        <Dialog
          title={failure.title}
          onCancel={dismiss}
          actions={
            <Button variant="primary" onClick={dismiss}>
              OK
            </Button>
          }
        >
          {failure.message}
        </Dialog>
      )}
      {failedSaveDialog}
    </div>
  );
}
