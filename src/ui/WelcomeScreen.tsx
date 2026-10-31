import { useId } from "react";
import type { RecentWorld } from "@/types/api";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { StackedLockup } from "./StackedLockup";

type WelcomeScreenProps = {
  recentWorlds: RecentWorld[];
  onOpenWorld: () => void;
  onNewWorld: () => void;
  onChooseRecent: (id: string) => void;
  onRemoveRecent: (id: string) => void;
};

/** The screen shown when no world is open. It fills its container. */
export function WelcomeScreen({
  recentWorlds,
  onOpenWorld,
  onNewWorld,
  onChooseRecent,
  onRemoveRecent,
}: WelcomeScreenProps) {
  const headingId = useId();

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-(--welcome-ground) px-6">
      <div className="flex shrink-0 basis-1/2 items-center justify-center">
        <StackedLockup height={120} />
      </div>
      <div className="mx-auto flex w-full max-w-120 flex-col gap-8 pb-12">
        <div className="flex flex-wrap justify-center gap-3">
          <Button variant="primary" onClick={onOpenWorld}>
            Open world…
          </Button>
          <Button variant="secondary" onClick={onNewWorld}>
            New world…
          </Button>
        </div>
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
          <h2 id={headingId} className="label-caps px-2 text-text-muted">
            Recent worlds
          </h2>
          {recentWorlds.length === 0 ? (
            <p className="ui px-2 text-text-muted">No worlds yet.</p>
          ) : (
            <ul className="flex flex-col">
              {recentWorlds.map((world) => (
                <li key={world.id} className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onChooseRecent(world.id)}
                    className="flex min-w-0 flex-1 flex-col items-start rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-hover"
                  >
                    <span className="ui-strong max-w-full truncate text-text">{world.name}</span>
                    <span className="ui-small max-w-full truncate text-text-muted">
                      {world.path}
                    </span>
                  </button>
                  {world.missing && (
                    <>
                      <span className="ui flex shrink-0 items-center gap-1 text-warning">
                        <Icon name="warning" />
                        Not found
                      </span>
                      <Button variant="ghost" onClick={() => onRemoveRecent(world.id)}>
                        Remove
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
