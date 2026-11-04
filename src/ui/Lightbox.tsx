import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

type LightboxProps = {
  /** The image's name, which titles the dialog and is the image's text alternative. */
  name: string;
  url: string;
  /** Shown beside the actions, such as the image's state. */
  status?: ReactNode;
  onClose: () => void;
  /** For a pending image: its actions, each run after the lightbox has closed. */
  pending?: { onApprove: () => void; onRegenerate: () => void; onReject: () => void };
};

/**
 * An image over the whole window, fitted inside it and never drawn larger than its natural size,
 * in a dialog named by the image, with Close focused first. A pending image has Approve, its one
 * primary button, Regenerate and Reject; each closes the lightbox before its action runs, so focus
 * has returned to the opener by then.
 */
export function Lightbox({ name, url, status, onClose, pending }: LightboxProps) {
  const closeThen = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <Dialog
      title={name}
      full
      closeButton
      onCancel={onClose}
      actions={
        (status || pending) && (
          <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span>{status}</span>
            {pending && (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={closeThen(pending.onApprove)}>
                  Approve
                </Button>
                <Button variant="secondary" onClick={closeThen(pending.onRegenerate)}>
                  Regenerate
                </Button>
                <Button variant="ghost" onClick={closeThen(pending.onReject)}>
                  Reject
                </Button>
              </div>
            )}
          </div>
        )
      }
    >
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
      </div>
    </Dialog>
  );
}
