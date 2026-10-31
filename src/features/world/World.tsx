import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { IpcError } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { WelcomeScreen } from "../../ui/WelcomeScreen";
import { type WorldOpened, worldClose, worldCreate, worldOpen, worldTreeKey } from "./commands";
import { useSaveConfirmation } from "./FailedSaveDialog";
import { NewWorldDialog } from "./NewWorldDialog";
import { useWorldStore } from "./store";
import { WorldScreen } from "./WorldScreen";

// Recent worlds arrive in a later package; until then their controls do nothing.
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
  const [newWorldOpen, setNewWorldOpen] = useState(false);
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

  function show(result: WorldOpened) {
    queryClient.removeQueries({ queryKey: worldTreeKey });
    opened(result);
  }

  const openWorld = () =>
    changeWorld(async () => {
      try {
        const result = await worldOpen();
        if (result) show(result);
      } catch (error) {
        setFailure({ title: "The folder cannot be opened", message: (error as IpcError).message });
      }
    });

  /**
   * The New world dialog's Create: once every page has saved, the core creates and opens the
   * world. Resolves to the core's error, which the dialog shows, or to null.
   */
  async function createWorld(name: string) {
    let failure: IpcError | null = null;
    await changeWorld(async () => {
      try {
        const result = await worldCreate(name);
        setNewWorldOpen(false);
        show(result);
      } catch (error) {
        failure = error as IpcError;
      }
    });
    return failure;
  }

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
          onNewWorld={() => setNewWorldOpen(true)}
          onCloseWorld={closeWorld}
        />
      ) : (
        <div className="relative h-full">
          <WelcomeScreen
            recentWorlds={[]}
            onOpenWorld={openWorld}
            onNewWorld={() => setNewWorldOpen(true)}
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
      {newWorldOpen && (
        <NewWorldDialog onCreate={createWorld} onCancel={() => setNewWorldOpen(false)} />
      )}
      {/* It opens after the New world dialog, so its portal comes later and shows over that one. */}
      {failedSaveDialog}
    </div>
  );
}
