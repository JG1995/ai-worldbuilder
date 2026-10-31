import { type Ref, useEffect, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import type { DiffLine } from "@/types/api";
import { Button } from "@/ui/Button";
import { pageCompare } from "../api/commands";
import { DiffLines } from "./DiffLines";

type CompareViewProps = {
  /** Keep mine, which the opener focuses because the Compare button that opened it is gone. */
  firstActionRef: Ref<HTMLButtonElement>;
  path: string;
  /** The editor's text when Compare opened. */
  text: string;
  onKeepMine: () => void;
  onLoadTheirs: () => void;
  /** Returns to the editor without resolving the conflict. */
  onClose: () => void;
};

/**
 * A read-only diff of the page on disk against the editor's text, from a comparison the core makes
 * when it opens, with the conflict's two resolutions.
 */
export function CompareView({
  firstActionRef,
  path,
  text,
  onKeepMine,
  onLoadTheirs,
  onClose,
}: CompareViewProps) {
  const [mine] = useState(text);
  const [result, setResult] = useState<{ lines: DiffLine[] } | { error: string } | null>(null);

  useEffect(() => {
    let current = true;
    pageCompare(path, mine).then(
      ({ lines }) => {
        if (current) setResult({ lines });
      },
      (error: IpcError) => {
        if (current) setResult({ error: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [path, mine]);

  return (
    <section aria-label="Compare" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="ui min-w-0 flex-1 text-text-muted">
          Lines marked − are only on disk, and lines marked + only in your text.
        </p>
        <Button ref={firstActionRef} variant="secondary" onClick={onKeepMine}>
          Keep mine
        </Button>
        <Button variant="ghost" onClick={onLoadTheirs}>
          Load theirs
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Back to editing
        </Button>
      </div>
      {result === null && <p className="ui text-text-muted">Comparing…</p>}
      {result && "error" in result && <p>The page cannot be compared: {result.error}</p>}
      {result && "lines" in result && (
        <DiffLines
          lines={result.lines}
          addedPrefix="Only in your text: "
          removedPrefix="Only on disk: "
        />
      )}
    </section>
  );
}
