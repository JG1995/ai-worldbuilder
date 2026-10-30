import { act, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

/** Stubs the window width rule; `setWide` crosses 960px and notifies the shell. */
function stubWidth(wide: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return wide;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (next: boolean) => {
    wide = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
}

function TestShell({
  initialWidth = 264,
  onTreeWidthChange = () => {},
  initialOpen = false,
}: {
  initialWidth?: number;
  onTreeWidthChange?: (width: number) => void;
  initialOpen?: boolean;
}) {
  const [width, setWidth] = useState(initialWidth);
  const [open, setOpen] = useState(initialOpen);
  const strip = (toggle: ReactNode) => (
    <div>
      {toggle}
      <button type="button">Saltmere tab</button>
    </div>
  );
  return (
    <Shell
      tree={<button type="button">Tree row</button>}
      tabStrip={strip}
      page={<button type="button">Page link</button>}
      treeWidth={width}
      onTreeWidthChange={(next) => {
        setWidth(next);
        onTreeWidthChange(next);
      }}
      treeOverlayOpen={open}
      onTreeOverlayOpenChange={setOpen}
    />
  );
}

const key = (name: string, options: { shiftKey?: boolean } = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: name, ...options });

describe("Shell", () => {
  it("changes the tree width with the arrow keys within 200px to 420px", () => {
    stubWidth(true);
    const onTreeWidthChange = vi.fn();
    render(<TestShell initialWidth={408} onTreeWidthChange={onTreeWidthChange} />);
    const separator = screen.getByRole("separator", { name: "File tree width" });

    act(() => separator.focus());
    key("ArrowRight");
    key("ArrowRight");
    expect(onTreeWidthChange.mock.calls).toEqual([[420]]);
    expect(separator).toHaveAttribute("aria-valuenow", "420");

    for (let i = 0; i < 20; i++) key("ArrowLeft");
    expect(onTreeWidthChange).toHaveBeenLastCalledWith(200);
    expect(separator).toHaveAttribute("aria-valuenow", "200");
  });

  it("moves focus between the panes with F6 and Shift+F6, back to the last focused element", () => {
    stubWidth(true);
    render(<TestShell />);
    const row = screen.getByRole("button", { name: "Tree row" });
    const link = screen.getByRole("button", { name: "Page link" });

    act(() => row.focus());
    key("F6");
    expect(screen.getByRole("button", { name: "Saltmere tab" })).toHaveFocus();
    act(() => link.focus());
    key("F6");
    expect(row).toHaveFocus();
    key("F6", { shiftKey: true });
    expect(link).toHaveFocus();
  });

  it("skips the closed overlay with F6", () => {
    stubWidth(false);
    render(<TestShell />);
    const link = screen.getByRole("button", { name: "Page link" });

    act(() => link.focus());
    key("F6");
    expect(link).toHaveFocus();
    key("F6", { shiftKey: true });
    expect(link).toHaveFocus();
  });

  it("closes the overlay on Escape and returns focus to the toggle", () => {
    stubWidth(false);
    render(<TestShell />);
    const toggle = screen.getByRole("button", { name: "File tree" });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const row = screen.getByRole("button", { name: "Tree row" });
    act(() => row.focus());
    key("Escape");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary", { hidden: true })).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });

  it("keeps the overlay open when Escape was already handled inside it", () => {
    stubWidth(false);
    render(<TestShell initialOpen />);
    const row = screen.getByRole("button", { name: "Tree row" });

    row.addEventListener("keydown", (event) => event.preventDefault());
    act(() => row.focus());
    key("Escape");

    expect(screen.getByRole("button", { name: "File tree" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows an open overlay as the side pane when widened, and leaves it closed when narrowed", () => {
    const setWide = stubWidth(false);
    render(<TestShell initialOpen />);
    const row = screen.getByRole("button", { name: "Tree row" });

    act(() => row.focus());
    setWide(true);
    expect(screen.queryByRole("button", { name: "File tree" })).not.toBeInTheDocument();
    expect(row).toBeVisible();
    expect(row).toHaveFocus();

    setWide(false);
    const toggle = screen.getByRole("button", { name: "File tree" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
});
