import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type IpcError, listenEvent } from "@/lib/ipc";
import type { WorldOpened } from "@/types/api";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { WelcomeScreen } from "@/ui/WelcomeScreen";
import {
  appClose,
  closeRequestedEvent,
  recentList,
  recentListKey,
  recentRemove,
  worldClose,
  worldCreate,
  worldOpen,
  worldOpenRecent,
  worldRestore,
  worldTreeKey,
} from "../api/commands";
import { followOutsideChanges } from "../logic/outside-changes";
import { saveWorkspace, useWorldStore } from "../stores/world-store";
import { useSaveConfirmation } from "./FailedSaveDialog";
import { NewWorldDialog } from "./NewWorldDialog";
import { type QuickOpenPorts, WorldScreen } from "./WorldScreen";

type Failure = { title: string; message: string };

/** The query key of the launch's one `world_restore`. */
const launchRestoreKey = ["world_restore"] as const;

type WorldProps = {
  /**
   * Renders the quick open dialog of the open world, which the world's screen opens from Ctrl/Cmd+O,
   * Ctrl/Cmd+K and the tree's Search button. Without it, there is no quick open.
   */
  quickOpen?: (ports: QuickOpenPorts) => ReactNode;
};

/**
 * The welcome screen or the open world, and the flows that open, switch and close worlds and the
 * window. At launch the world that was open last reopens. Before the world changes or the window
 * closes, every open page saves, with the failed-save dialog for each one that cannot, and then
 * the workspace saves.
 */
export function World({ quickOpen }: WorldProps) {
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
  const root = useRef<HTMLDivElement>(null);
  /** What had focus when the world change started, to return focus there if the world stays. */
  const changeOpener = useRef<Element | null>(null);

  // A change makes the root inert, and the browser then takes focus off it. The root turns inert
  // only after the commit that starts the change, so a menu that started it has returned focus to
  // its button first, which is the element remembered here. Dialogs render in portals outside the
  // root, so they still take input while it is inert.
  useEffect(() => {
    if (!changingWorld) return;
    changeOpener.current = document.activeElement;
    root.current?.setAttribute("inert", "");
  }, [changingWorld]);

  // When the change ends without leaving the screen, focus that the root lost returns to where the
  // change started, before a dialog that shows its failure records where to return focus.
  useLayoutEffect(() => {
    if (changingWorld) return;
    root.current?.removeAttribute("inert");
    const opener = changeOpener.current;
    changeOpener.current = null;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, [changingWorld]);

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
      // The query cache makes it one restore per page load. React's StrictMode runs this effect
      // twice in development, and two restores could finish out of order, leaving this screen on
      // an older session than the core's, whose events it would then ignore.
      const result = await queryClient.fetchQuery({
        queryKey: launchRestoreKey,
        queryFn: worldRestore,
        staleTime: Infinity,
        gcTime: Infinity,
      });
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

  // From launch, not from each opening: the core can report an opening's first events before the
  // interface has its result.
  useEffect(() => followOutsideChanges(queryClient), [queryClient]);

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

  useEffect(() => listenEvent(closeRequestedEvent, () => void closeWindow()), []);

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
          confirmSaved={confirmSaved}
          quickOpen={quickOpen}
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
    <div ref={root} className="h-screen">
      {screen()}
      {/* After the change that failed has ended, so it returns focus to where that change started. */}
      {failure && !changingWorld && (
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
