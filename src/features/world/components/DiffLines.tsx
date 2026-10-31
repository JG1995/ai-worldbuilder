import type { DiffLine } from "@/types/api";

type DiffLinesProps = {
  lines: DiffLine[];
  /** What a screen reader says before an added line, such as "Only in your text: ". */
  addedPrefix: string;
  /** What a screen reader says before a removed line. */
  removedPrefix: string;
};

const lineStyles: Record<DiffLine["kind"], { row: string; marker: string; text: string }> = {
  same: { row: "text-text-muted", marker: "", text: "" },
  added: { row: "bg-diff-added text-text", marker: "text-success", text: "" },
  removed: { row: "bg-diff-removed text-text", marker: "text-error", text: "line-through" },
};

const markers: Record<DiffLine["kind"], string> = { same: "", added: "+", removed: "−" };

/**
 * A line diff in Compare's style: unchanged lines muted, added lines marked + on the added ground,
 * and removed lines marked − on the removed ground and struck through, each changed line with its
 * spoken prefix.
 */
export function DiffLines({ lines, addedPrefix, removedPrefix }: DiffLinesProps) {
  const spokenKinds: Record<DiffLine["kind"], string> = {
    same: "",
    added: addedPrefix,
    removed: removedPrefix,
  };
  return (
    <ol aria-label="Differences" className="flex flex-col">
      {lines.map((line, index) => (
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
  );
}
