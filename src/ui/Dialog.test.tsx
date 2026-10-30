import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

function DeleteConfirmation() {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Delete page…
      </Button>
      {open && (
        <Dialog
          title='Delete "Saltmere"?'
          initialFocus={cancel}
          onCancel={() => setOpen(false)}
          actions={
            <>
              <Button variant="destructive">Delete "Saltmere"</Button>
              <Button ref={cancel} variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </>
          }
        >
          The page file moves to the system trash.
        </Dialog>
      )}
    </>
  );
}

function openDialog() {
  render(<DeleteConfirmation />);
  const opener = screen.getByRole("button", { name: "Delete page…" });
  act(() => opener.focus());
  fireEvent.click(opener);
  return opener;
}

describe("Dialog", () => {
  it("is a modal dialog named by its title that focuses the named element", () => {
    openDialog();

    const dialog = screen.getByRole("dialog", { name: 'Delete "Saltmere"?' });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("wraps Tab and Shift+Tab at its ends", () => {
    openDialog();
    const first = screen.getByRole("button", { name: 'Delete "Saltmere"' });
    const last = screen.getByRole("button", { name: "Cancel" });

    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("cancels on Escape and returns focus to the element that opened it", () => {
    const opener = openDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
