import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IpcError } from "@/lib/ipc";
import type { DiffLine, HistoryVersion, VersionKind } from "@/types/api";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { historyCompare, historyList } from "../api/commands";
import type { PageSaver } from "../logic/saving";
import { DiffLines } from "./DiffLines";

/** How each version came about, as its label says. */
const versionLabels: Record<VersionKind, string> = {
  edit: "Edit",
  new_page: "New page",
  restored_missing: "Restored after it was deleted outside",
  keep_mine: "Keep mine",
  restore: "Restored version",
  undo: "Undo",
  outside: "Changed outside Grimoire.md",
};

/** When a version was recorded, in local date and time, as the list and the restore toast say. */
export function versionTime(at: number) {
  return new Date(at * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** The list's first entry, the page's text now, which has no version id. */
const current = "current";

type HistoryViewProps = {
  path: string;
  saver: PageSaver;
  /** True while the page shows a notice, such as the conflict, failed-save or missing-page one. */
  restoreBlocked: boolean;
  /** Restores a version, and resolves to the reason it could not, or null. */
  onRestore: (version: HistoryVersion) => Promise<string | null>;
  /** Returns to the editor. */
  onClose: () => void;
};

/**
 * A page's history in place of its editor: its versions, newest first after Current, the changes
 * since the selected one, and Restore this version. It saves pending edits first, then lists the
 * versions, and lists them again whenever the page's saved version changes, so a change on disk
 * shows as the new Current.
 */
export function HistoryView({ path, saver, restoreBlocked, onRestore, onClose }: HistoryViewProps) {
  const savedVersion = useSyncExternalStore(saver.subscribe, saver.savedVersion);
  const [flushed, setFlushed] = useState(false);
  const [listing, setListing] = useState<{ versions: HistoryVersion[] } | { error: string } | null>(
    null,
  );
  const [selected, setSelected] = useState(current);
  const [changes, setChanges] = useState<
    { key: string; lines: DiffLine[] } | { key: string; error: string } | null
  >(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    let live = true;
    void saver.flush().then(() => {
      if (live) setFlushed(true);
    });
    return () => {
      live = false;
    };
  }, [saver]);

  // Once pending edits are saved, the list follows the saved version, which changes with the page
  // on disk.
  const listedVersion = flushed ? savedVersion : null;
  useEffect(() => {
    if (listedVersion === null) return;
    let live = true;
    historyList(path).then(
      (versions) => {
        if (!live) return;
        setListing({ versions });
        // The selection stays on a version still listed, and starts on the newest earlier one.
        setSelected((previous) =>
          versions.some((version) => version.id === previous)
            ? previous
            : (versions[0]?.id ?? current),
        );
      },
      (error: IpcError) => {
        if (live) setListing({ error: error.message });
      },
    );
    return () => {
      live = false;
    };
  }, [listedVersion, path]);

  // The changes go from the selected version to the text on disk, which the editor's matches.
  const changesKey = `${selected}@${savedVersion}`;
  useEffect(() => {
    if (selected === current) return;
    let live = true;
    historyCompare(path, selected, saver.text()).then(
      (lines) => {
        if (live) setChanges({ key: changesKey, lines });
      },
      (error: IpcError) => {
        if (live) setChanges({ key: changesKey, error: error.message });
      },
    );
    return () => {
      live = false;
    };
  }, [path, saver, selected, changesKey]);

  // Focus moves to the selected version once the view first shows the list, or to Back to editing.
  useEffect(() => {
    if (focused.current || listing === null) return;
    focused.current = true;
    if ("error" in listing) back.current?.focus();
    else list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [listing]);

  const versions = listing && "versions" in listing ? listing.versions : [];
  const entries = [current, ...versions.map((version) => version.id)];
  const selectedVersion = versions.find((version) => version.id === selected);

  function select(index: number) {
    const id = entries[Math.max(0, Math.min(index, entries.length - 1))];
    setSelected(id);
    setRestoreError(null);
    list.current?.querySelector<HTMLElement>(`[data-version="${id}"]`)?.focus();
  }

  function moveSelection(event: KeyboardEvent, index: number) {
    const targets: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: entries.length - 1,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    select(targets[event.key]);
  }

  async function restore() {
    if (!selectedVersion) return;
    setRestoring(true);
    setRestoreError(null);
    const reason = await onRestore(selectedVersion);
    // A restore that worked closes the view.
    setRestoring(false);
    setRestoreError(reason);
  }

  const shownChanges = changes?.key === changesKey ? changes : null;

  return (
    <section aria-label="History" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="heading-4 min-w-0 flex-1">History</h2>
        <Button ref={back} variant="ghost" onClick={onClose}>
          Back to editing
        </Button>
      </div>
      {listing === null && <p className="ui text-text-muted">Loading…</p>}
      {listing && "error" in listing && (
        <Notice status="error">The page's history cannot be read: {listing.error}</Notice>
      )}
      {listing && "versions" in listing && (
        <div className="flex flex-col gap-6 @wide:flex-row @wide:items-start">
          <div
            ref={list}
            role="listbox"
            aria-label="Versions"
            className="flex shrink-0 flex-col @wide:w-60"
          >
            {entries.map((id, index) => {
              const version = versions[index - 1];
              const isSelected = id === selected;
              return (
                <div
                  key={id}
                  role="option"
                  data-version={id}
                  aria-selected={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => select(index)}
                  onKeyDown={(event) => moveSelection(event, index)}
                  className={`relative flex cursor-default select-none flex-col px-3 py-2 transition-colors focus-visible:-outline-offset-2 ${
                    isSelected
                      ? "bg-selected text-text before:absolute before:inset-y-0 before:left-0 before:border-accent before:border-l-2"
                      : "text-text-muted hover:bg-hover hover:text-text"
                  }`}
                >
                  {version ? (
                    <>
                      <span className="ui-strong">{versionTime(version.at)}</span>
                      <span className="ui-small">{versionLabels[version.kind]}</span>
                    </>
                  ) : (
                    <span className="ui-strong">Current</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {restoreError !== null && (
              <Notice status="error">This version could not be restored: {restoreError}</Notice>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <p className="ui min-w-0 flex-1 text-text-muted">
                {selectedVersion
                  ? "Lines marked − are only in this version, and lines marked + only in the current text."
                  : versions.length === 0
                    ? "Earlier versions appear once Grimoire.md saves this page."
                    : "This is the page's current text. Select an earlier version to see what changed since."}
              </p>
              <Button
                variant="primary"
                disabled={!selectedVersion || restoreBlocked}
                loading={restoring}
                onClick={() => void restore()}
              >
                Restore this version
              </Button>
            </div>
            {selectedVersion && shownChanges === null && (
              <p className="ui text-text-muted">Comparing…</p>
            )}
            {shownChanges && "error" in shownChanges && (
              <p>The changes cannot be shown: {shownChanges.error}</p>
            )}
            {shownChanges && "lines" in shownChanges && (
              <DiffLines
                lines={shownChanges.lines}
                addedPrefix="Only in the current text: "
                removedPrefix="Only in this version: "
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
