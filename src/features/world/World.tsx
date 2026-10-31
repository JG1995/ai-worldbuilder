import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { type IpcError, listenEvent } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { WelcomeScreen } from "../../ui/WelcomeScreen";
import {
  appClose,
  closeRequestedEvent,
  recentList,
  recentListKey,
  recentRemove,
  type WorldOpened,
  worldClose,
  worldCreate,
  worldOpen,
  worldOpenRecent,
  worldRestore,
  worldTreeKey,
} from "./commands";
import { useSaveConfirmation } from "./FailedSaveDialog";
import { NewWorldDialog } from "./NewWorldDialog";
import { saveWorkspace, useWorldStore } from "./store";
import { WorldScreen } from "./WorldScreen";

type Failure = { title: string; message: string };

/**
 * The welcome screen or the open world, and the flows that open, switch and close worlds and the
 * window. At launch the world that was open last reopens. Before the world changes or the window
 * closes, every open page saves, with the failed-save dialog for each one that cannot, and then
 * the workspace saves.
 */
export function World() {
  const world = useWorldStore((store) => store.world);
  const changingWorld = useWorldStore((store) => store.changingWorld);
  const { opened, closed, setChangingWorld, holdSaving } = useWorldStore.getState();
  const queryClient = useQueryClient();
  // Until the last world has reopened or there is none, neither screen shows, so the welcome
  // screen does not flash up before the world.
  const [launching, setLaunching] = useState(true);
  const recent = useQuery({ queryKey: recentListKey, queryFn: recentList, enabled: !launching });
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
   * Runs `change` once every page and the workspace have saved. One change runs at a time, and the
   * world takes no edits until it ends, so none can be made after its page saved and then dropped
   * with its editor or the window. Autosave waits meanwhile, so no save meant for this world can
   * reach the core after it has switched to another; the store's `opened` and `closed` then stop
   * this world's savers.
   */
  async function changeWorld(change: () => Promise<void>) {
    if (useWorldStore.getState().changingWorld) return;
    setChangingWorld(true);
    try {
      if (!(await confirmAllSaved())) return;
      await saveWorkspace();
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
    // The opened world moves to the top of the list and leaves the world menu.
    void queryClient.invalidateQueries({ queryKey: recentListKey });
  }

  const restore = useEffectEvent(async (isCurrent: () => boolean) => {
    try {
      const result = await worldRestore();
      if (result && isCurrent()) show(result);
    } finally {
      if (isCurrent()) setLaunching(false);
    }
  });

  useEffect(() => {
    let current = true;
    restore(() => current).catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  /** The user closed the window while a world is open: it closes once everything has saved. */
  const closeWindow = useEffectEvent(() =>
    changeWorld(async () => {
      try {
        await appClose();
      } catch (error) {
        setFailure({ title: "The window cannot be closed", message: (error as IpcError).message });
      }
    }),
  );

  useEffect(() => {
    let stop: (() => void) | undefined;
    let current = true;
    void listenEvent(closeRequestedEvent, () => void closeWindow()).then((unlisten) => {
      if (current) stop = unlisten;
      else unlisten();
    });
    return () => {
      current = false;
      stop?.();
    };
  }, []);

  const openWorld = () =>
    changeWorld(async () => {
      try {
        const result = await worldOpen();
        if (result) show(result);
      } catch (error) {
        setFailure({ title: "The folder cannot be opened", message: (error as IpcError).message });
      }
    });

  const openRecent = (id: string) =>
    changeWorld(async () => {
      try {
        show(await worldOpenRecent(id));
      } catch (error) {
        setFailure({ title: "The world cannot be opened", message: (error as IpcError).message });
        // A world whose folder has gone since the list was shown is now marked as missing.
        void queryClient.invalidateQueries({ queryKey: recentListKey });
      }
    });

  async function removeRecent(id: string) {
    try {
      await recentRemove(id);
    } catch (error) {
      setFailure({ title: "The world cannot be removed", message: (error as IpcError).message });
    }
    await queryClient.invalidateQueries({ queryKey: recentListKey });
  }

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
      // The welcome screen then lists the closed world too, at once.
      await queryClient.invalidateQueries({ queryKey: recentListKey });
      closed();
      queryClient.removeQueries({ queryKey: worldTreeKey });
    });

  const dismiss = () => setFailure(null);

  function screen() {
    if (launching) return null;
    if (world) {
      return (
        <WorldScreen
          key={world.session}
          session={world.session}
          worldName={world.name}
          recentWorlds={recent.data ?? []}
          onOpenRecent={openRecent}
          onOpenWorld={openWorld}
          onNewWorld={() => setNewWorldOpen(true)}
          onCloseWorld={closeWorld}
        />
      );
    }
    // Until the recent worlds arrive, so "No worlds yet." does not flash up before them.
    if (recent.isPending) return null;
    return (
      <div className="relative h-full">
        <WelcomeScreen
          recentWorlds={recent.data ?? []}
          onOpenWorld={openWorld}
          onNewWorld={() => setNewWorldOpen(true)}
          onChooseRecent={openRecent}
          onRemoveRecent={removeRecent}
        />
        {import.meta.env.DEV && (
          <a href="/showcase.html" className="ui absolute top-3 right-4 text-accent underline">
            Showcase
          </a>
        )}
      </div>
    );
  }

  return (
    // Dialogs render in portals outside this element, so they still take input while it is inert.
    <div className="h-screen" inert={changingWorld}>
      {screen()}
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
