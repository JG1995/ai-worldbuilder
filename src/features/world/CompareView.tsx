import { useEffect, useState } from "react";
import type { IpcError } from "../../lib/ipc";
import { Button } from "../../ui/Button";
import { type DiffLine, pageCompare } from "./commands";

type CompareViewProps = {
  path: string;
  /** The editor's text when Compare opened. */
  text: string;
  onKeepMine: () => void;
  onLoadTheirs: () => void;
  /** Returns to the editor without resolving the conflict. */
  onClose: () => void;
};

const lineStyles: Record<DiffLine["kind"], { row: string; marker: string; text: string }> = {
  same: { row: "text-text-muted", marker: "", text: "" },
  added: { row: "bg-diff-added text-text", marker: "text-success", text: "" },
  removed: { row: "bg-diff-removed text-text", marker: "text-error", text: "line-through" },
};

const markers: Record<DiffLine["kind"], string> = { same: "", added: "+", removed: "−" };
const spokenKinds: Record<DiffLine["kind"], string> = {
  same: "",
  added: "Only in your text: ",
  removed: "Only on disk: ",
};

/**
 * A read-only diff of the page on disk against the editor's text, from a comparison the core makes
 * when it opens, with the conflict's two resolutions.
 */
export function CompareView({ path, text, onKeepMine, onLoadTheirs, onClose }: CompareViewProps) {
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
        <Button variant="secondary" onClick={onKeepMine}>
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
        <ol aria-label="Differences" className="flex flex-col">
          {result.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place, and the list never changes.
            <li key={index} className={`flex gap-2 ${lineStyles[line.kind].row}`}>
              <span
                aria-hidden="true"
                className={`w-4 shrink-0 text-center ${lineStyles[line.kind].marker}`}
              >
                {markers[line.kind]}
              </span>
              <span
                className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${lineStyles[line.kind].text}`}
              >
                <span className="sr-only">{spokenKinds[line.kind]}</span>
                {line.text || " "}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
