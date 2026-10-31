import { useEffect, useId, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Icon } from "@/ui/Icon";
import { TextInput } from "@/ui/TextInput";
import { worldNewBrowse, worldNewLocation } from "../api/commands";

type NewWorldDialogProps = {
  /**
   * Creates and opens the world. Resolves to the core's error when it cannot, and to null when it
   * did or when the user stopped it, for example on a page that could not be saved.
   */
  onCreate: (name: string) => Promise<IpcError | null>;
  onCancel: () => void;
};

/** Errors about the name itself show under the input; the others below the form. */
const nameErrorKinds = new Set(["invalid_name", "exists"]);

/**
 * Asks for a new world's name and location. It shows and changes the location through the core
 * and reports Create with the name; the caller creates the world and closes the dialog.
 */
export function NewWorldDialog({ onCreate, onCancel }: NewWorldDialogProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string>();
  const [error, setError] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let current = true;
    worldNewLocation().then(
      (result) => current && setLocation(result.location),
      (failure: IpcError) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, []);

  async function browse() {
    setBrowsing(true);
    try {
      const picked = await worldNewBrowse();
      if (picked) setLocation(picked.location);
    } catch (failure) {
      setError((failure as IpcError).message);
    } finally {
      setBrowsing(false);
    }
  }

  async function create() {
    if (creating || browsing) return;
    setCreating(true);
    setNameError(undefined);
    setError(undefined);
    const failure = await onCreate(name);
    // On success the caller has closed the dialog, and these updates change nothing.
    setCreating(false);
    if (!failure) return;
    if (nameErrorKinds.has(failure.kind)) setNameError(failure.message);
    else setError(failure.message);
  }

  return (
    <Dialog
      title="New world"
      // The world may already be changing; the caller closes the dialog when it is done.
      onCancel={() => !creating && onCancel()}
      actions={
        <>
          <Button variant="secondary" disabled={creating} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={creating}>
            Create
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <TextInput
          label="Name"
          value={name}
          error={nameError}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <fieldset className="min-w-0">
          <legend className="ui mb-1 text-text">Location</legend>
          <div className="flex items-center gap-2">
            <span className="ui min-w-0 flex-1 break-all text-text-muted">{location ?? "…"}</span>
            <Button
              variant="secondary"
              disabled={creating}
              loading={browsing}
              onClick={() => void browse()}
            >
              Browse…
            </Button>
          </div>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="ui-small flex items-center gap-1 text-error">
          <Icon name="error" />
          {error}
        </p>
      )}
    </Dialog>
  );
}
