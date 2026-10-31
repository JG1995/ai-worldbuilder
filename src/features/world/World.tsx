import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { IpcError } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { WelcomeScreen } from "../../ui/WelcomeScreen";
import { worldClose, worldOpen, worldTreeKey } from "./commands";
import { useWorldStore } from "./store";
import { WorldScreen } from "./WorldScreen";

// New world and recent worlds arrive in later packages; until then their controls do nothing.
const notYet = () => {};

type Failure = { title: string; message: string };

/** The welcome screen or the open world, and the flows that open and close worlds. */
export function World() {
  const world = useWorldStore((store) => store.world);
  const { opened, closed } = useWorldStore.getState();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<Failure | null>(null);
  const opening = useRef(false);

  async function openWorld() {
    // The core shows one folder dialog at a time.
    if (opening.current) return;
    opening.current = true;
    try {
      const result = await worldOpen();
      if (!result) return;
      queryClient.removeQueries({ queryKey: worldTreeKey });
      opened(result);
    } catch (error) {
      setFailure({ title: "The folder cannot be opened", message: (error as IpcError).message });
    } finally {
      opening.current = false;
    }
  }

  async function closeWorld() {
    try {
      await worldClose();
    } catch (error) {
      setFailure({ title: "The world cannot be closed", message: (error as IpcError).message });
      return;
    }
    closed();
    queryClient.removeQueries({ queryKey: worldTreeKey });
  }

  const dismiss = () => setFailure(null);

  return (
    <div className="h-screen">
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
    </div>
  );
}
