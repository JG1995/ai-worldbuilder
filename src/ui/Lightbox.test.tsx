import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Lightbox } from "./Lightbox";

type Pending = Parameters<typeof Lightbox>[0]["pending"];

/** A thumbnail that opens the lightbox; `steps` records each close. */
function Opener({ pending, steps }: { pending?: Pending; steps?: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Thumbnail
      </button>
      {open && (
        <Lightbox
          name="Harbourmaster Oslo"
          url="blob:sample"
          onClose={() => {
            steps?.push("close");
            setOpen(false);
          }}
          pending={pending}
        />
      )}
    </>
  );
}

function open(pending?: Pending, steps?: string[]) {
  render(<Opener pending={pending} steps={steps} />);
  const thumbnail = screen.getByRole("button", { name: "Thumbnail" });
  act(() => thumbnail.focus());
  fireEvent.click(thumbnail);
  return { thumbnail, dialog: screen.getByRole("dialog", { name: "Harbourmaster Oslo" }) };
}

describe("Lightbox", () => {
  it("shows the image named by its name, fitted to the window without enlarging it, with Close focused", () => {
    const { dialog } = open();

    const image = within(dialog).getByRole("img", { name: "Harbourmaster Oslo" });
    expect(image).toHaveAttribute("src", "blob:sample");
    // Only maximums: an image smaller than the window keeps its natural size.
    expect(image).toHaveClass("max-h-full", "max-w-full", "object-contain");
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  });

  it("closes on Escape and on Close, returning focus to the thumbnail", () => {
    const { thumbnail, dialog } = open();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(thumbnail).toHaveFocus();

    fireEvent.click(thumbnail);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(thumbnail).toHaveFocus();
  });

  it("offers a pending image's actions with Approve primary, each closing it before it runs", () => {
    const steps: string[] = [];
    const run = (action: string) => () => steps.push(action);
    const { dialog } = open(
      { onApprove: run("approve"), onRegenerate: run("regenerate"), onReject: run("reject") },
      steps,
    );

    expect(within(dialog).getByRole("button", { name: "Approve" })).toHaveClass("bg-accent");
    expect(within(dialog).getByRole("button", { name: "Regenerate" })).not.toHaveClass("bg-accent");
    expect(within(dialog).getByRole("button", { name: "Reject" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

    expect(steps).toEqual(["close", "approve"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
