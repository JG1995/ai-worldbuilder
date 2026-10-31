import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { missingReason, type SaveResult } from "../logic/saving";
import { useWorldStore } from "../stores/world-store";
import { pageNameOf } from "../utils/paths";

type Choice = "try-again" | "discard" | "cancel";

type FailedSaveDialogProps = {
  pageName: string;
  reason: string;
  onChoose: (choice: Choice) => void;
};

/** Asks what to do with a page that cannot be saved before it closes. Cancel has focus. */
export function FailedSaveDialog({ pageName, reason, onChoose }: FailedSaveDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      title={`"${pageName}" could not be saved`}
      initialFocus={cancel}
      onCancel={() => onChoose("cancel")}
      actions={
        <>
          <Button ref={cancel} variant="secondary" onClick={() => onChoose("cancel")}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onChoose("discard")}>
            Discard changes
          </Button>
          <Button variant="primary" onClick={() => onChoose("try-again")}>
            Try again
          </Button>
        </>
      }
    >
      <p>{reason}</p>
      <p>Discard changes loses this page's unsaved edits and nothing else.</p>
    </Dialog>
  );
}

function reasonOf(result: SaveResult) {
  switch (result.kind) {
    case "failed":
      return result.reason;
    case "missing":
      return missingReason;
    default:
      return "The page changed on disk while it had unsaved edits.";
  }
}

/**
 * `confirmSaved(path)` saves an open page and, while it cannot be saved, asks with the failed-save
 * dialog. It resolves to true when the page saved, had nothing to save, or the user chose to
 * discard its edits, and to false on Cancel. Calls run one at a time, so one dialog shows at once.
 */
export function useSaveConfirmation(): {
  confirmSaved: (path: string) => Promise<boolean>;
  failedSaveDialog: ReactNode;
} {
  const [question, setQuestion] = useState<{
    path: string;
    reason: string;
    answer: (choice: Choice) => void;
  } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const ask = (path: string, reason: string) =>
    new Promise<Choice>((resolve) =>
      setQuestion({
        path,
        reason,
        answer: (choice) => {
          setQuestion(null);
          resolve(choice);
        },
      }),
    );

  async function confirm(path: string) {
    for (;;) {
      const result = await useWorldStore.getState().flush(path);
      if (result.kind === "saved" || result.kind === "clean") return true;
      const choice = await ask(path, reasonOf(result));
      if (choice !== "try-again") return choice === "discard";
    }
  }

  function confirmSaved(path: string) {
    const run = queue.current.then(() => confirm(path));
    queue.current = run.catch(() => undefined);
    return run;
  }

  const failedSaveDialog = question && (
    <FailedSaveDialog
      pageName={pageNameOf(question.path)}
      reason={question.reason}
      onChoose={question.answer}
    />
  );
  return { confirmSaved, failedSaveDialog };
}
