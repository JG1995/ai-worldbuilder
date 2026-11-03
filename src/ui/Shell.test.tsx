import { act, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

/**
 * Stubs the window's width for the shell's `(min-width: …)` rules; the returned function changes
 * it and notifies the shell.
 */
function stubWidth(width: number) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return width >= Number(/min-width: (\d+)px/.exec(query)?.[1]);
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: number) => {
    width = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
}

/** Content with state of its own, which survives only while it stays mounted. */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Count {count}
    </button>
  );
}

function TestShell({
  initialWidth = 264,
  onTreeWidthChange = () => {},
  initialOpen = false,
  assistant,
  initialAssistantOpen = false,
  onAssistantWidthChange = () => {},
  collapsed = false,
}: {
  initialWidth?: number;
  onTreeWidthChange?: (width: number) => void;
  initialOpen?: boolean;
  assistant?: ReactNode;
  initialAssistantOpen?: boolean;
  onAssistantWidthChange?: (width: number) => void;
  /** Collapses both panes, as the reading layout does. */
  collapsed?: boolean;
}) {
  const [width, setWidth] = useState(initialWidth);
  const [open, setOpen] = useState(initialOpen);
  const [assistantOpen, setAssistantOpen] = useState(initialAssistantOpen);
  const [assistantWidth, setAssistantWidth] = useState(360);
  const [assistantOverlayOpen, setAssistantOverlayOpen] = useState(false);
  const strip = (toggle: ReactNode, assistantToggle: ReactNode) => (
    <div>
      {toggle}
      <button type="button">Saltmere tab</button>
      {assistantToggle}
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
      treeCollapsed={collapsed}
      assistant={assistant}
      assistantOpen={assistantOpen}
      onAssistantOpenChange={setAssistantOpen}
      assistantWidth={assistantWidth}
      onAssistantWidthChange={(next) => {
        setAssistantWidth(next);
        onAssistantWidthChange(next);
      }}
      assistantOverlayOpen={assistantOverlayOpen}
      onAssistantOverlayOpenChange={setAssistantOverlayOpen}
      assistantCollapsed={collapsed}
    />
  );
}

const key = (name: string, options: { shiftKey?: boolean } = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: name, ...options });

const assistantButton = () => screen.getByRole("button", { name: "Assistant" });
/** The pane the Assistant button controls; a hidden pane has no accessible name to query by. */
const assistantPane = () => {
  const pane = document.getElementById(assistantButton().getAttribute("aria-controls") ?? "");
  expect(pane).toHaveAttribute("aria-label", "Assistant");
  return pane as HTMLElement;
};

describe("Shell", () => {
  it("changes the tree width with the arrow keys within 200px to 420px", () => {
    stubWidth(1024);
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
    stubWidth(1024);
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
    stubWidth(800);
    render(<TestShell />);
    const link = screen.getByRole("button", { name: "Page link" });

    act(() => link.focus());
    key("F6");
    expect(link).toHaveFocus();
    key("F6", { shiftKey: true });
    expect(link).toHaveFocus();
  });

  it("closes the overlay on Escape and returns focus to the toggle", () => {
    stubWidth(800);
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
    stubWidth(800);
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
    const setWidth = stubWidth(800);
    render(<TestShell initialOpen />);
    const row = screen.getByRole("button", { name: "Tree row" });

    act(() => row.focus());
    setWidth(1024);
    expect(screen.queryByRole("button", { name: "File tree" })).not.toBeInTheDocument();
    expect(row).toBeVisible();
    expect(row).toHaveFocus();

    setWidth(800);
    const toggle = screen.getByRole("button", { name: "File tree" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  describe("collapsed", () => {
    const tree = () => screen.getByRole("complementary", { hidden: true });

    it("hides the tree at 1280px behind the tree button, which opens it beside the page and as an overlay below 960px", () => {
      const setWidth = stubWidth(1280);
      render(<TestShell collapsed />);
      const toggle = screen.getByRole("button", { name: "File tree" });
      expect(tree()).not.toBeVisible();
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(toggle);
      expect(tree()).toBeVisible();
      expect(tree()).not.toHaveClass("absolute");

      setWidth(800);
      expect(tree()).toBeVisible();
      expect(tree()).toHaveClass("absolute");
      setWidth(1280);
      expect(tree()).toBeVisible();

      fireEvent.click(toggle);
      expect(tree()).not.toBeVisible();
    });

    it("hides the open assistant at 1280px until its button opens it, leaving its side pane state", () => {
      stubWidth(1280);
      const assistant = <button type="button">Settings</button>;
      const { rerender } = render(
        <TestShell assistant={assistant} initialAssistantOpen collapsed />,
      );
      expect(assistantPane()).not.toBeVisible();

      fireEvent.click(assistantButton());
      expect(assistantPane()).toBeVisible();
      fireEvent.click(assistantButton());
      expect(assistantPane()).not.toBeVisible();

      rerender(<TestShell assistant={assistant} initialAssistantOpen />);
      expect(assistantPane()).toBeVisible();
      // Showing again as the collapse ends is not an opening, so focus stays on the button.
      expect(assistantButton()).toHaveFocus();
    });

    it.each([
      ["tree", "Tree row"],
      ["assistant", "Settings"],
    ])("moves focus from the %s to the page when it collapses", (_, control) => {
      stubWidth(1280);
      const assistant = <button type="button">Settings</button>;
      const { rerender } = render(<TestShell assistant={assistant} initialAssistantOpen />);
      act(() => screen.getByRole("button", { name: control }).focus());

      rerender(<TestShell assistant={assistant} initialAssistantOpen collapsed />);

      expect(screen.getByRole("button", { name: "Page link" })).toHaveFocus();
    });
  });

  describe("with an assistant", () => {
    it("has no pane and no button without one", () => {
      stubWidth(1280);
      render(<TestShell initialAssistantOpen />);

      expect(screen.queryByRole("button", { name: "Assistant" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("complementary", { hidden: true })).toHaveLength(1);
    });

    it("opens and closes the side pane from its button at 1280px, and reports it", () => {
      stubWidth(1280);
      render(<TestShell assistant={<p>Ask about the world</p>} />);

      expect(assistantButton()).toHaveAttribute("aria-expanded", "false");
      expect(assistantPane()).not.toBeVisible();
      fireEvent.click(assistantButton());
      expect(assistantButton()).toHaveAttribute("aria-expanded", "true");
      expect(assistantPane()).toBeVisible();
      expect(assistantPane()).toHaveStyle({ width: "360px" });

      fireEvent.click(assistantButton());
      expect(assistantButton()).toHaveAttribute("aria-expanded", "false");
      expect(assistantPane()).not.toBeVisible();
    });

    it("moves focus on opening to the element marked for it, else the first control, else the pane", () => {
      stubWidth(1280);
      const { unmount } = render(
        <TestShell
          assistant={
            <>
              <button type="button">New conversation</button>
              <textarea aria-label="Message" data-initial-focus />
            </>
          }
        />,
      );
      fireEvent.click(assistantButton());
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
      unmount();

      const second = render(<TestShell assistant={<button type="button">Settings</button>} />);
      fireEvent.click(assistantButton());
      expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
      second.unmount();

      render(<TestShell assistant={<p>Ask about the world</p>} />);
      fireEvent.click(assistantButton());
      expect(assistantPane()).toHaveFocus();
    });

    it("leaves focus where it is when the pane shows without being opened", () => {
      const setWidth = stubWidth(1024);
      render(
        <TestShell assistant={<button type="button">Settings</button>} initialAssistantOpen />,
      );
      const link = screen.getByRole("button", { name: "Page link" });
      act(() => link.focus());

      setWidth(1280);

      expect(assistantPane()).toBeVisible();
      expect(link).toHaveFocus();
    });

    it("changes the width from its left edge with the arrow keys within 300px to 560px", () => {
      stubWidth(1280);
      const onAssistantWidthChange = vi.fn();
      render(
        <TestShell
          assistant={<p>Ask about the world</p>}
          initialAssistantOpen
          onAssistantWidthChange={onAssistantWidthChange}
        />,
      );
      const separator = screen.getByRole("separator", { name: "Assistant width" });
      expect(separator).toHaveAttribute("aria-valuemin", "300");
      expect(separator).toHaveAttribute("aria-valuemax", "560");

      act(() => separator.focus());
      key("ArrowLeft");
      expect(onAssistantWidthChange).toHaveBeenLastCalledWith(376);
      for (let i = 0; i < 20; i++) key("ArrowLeft");
      expect(separator).toHaveAttribute("aria-valuenow", "560");
      for (let i = 0; i < 20; i++) key("ArrowRight");
      expect(separator).toHaveAttribute("aria-valuenow", "300");
      expect(assistantPane()).toHaveStyle({ width: "300px" });
    });

    it("opens as an overlay below 1280px, which Escape and a press outside close", () => {
      stubWidth(1024);
      render(
        <TestShell assistant={<button type="button">Settings</button>} initialAssistantOpen />,
      );

      // The side pane's saved state does not open the overlay.
      expect(assistantPane()).not.toBeVisible();
      fireEvent.click(assistantButton());
      expect(assistantPane()).toBeVisible();
      expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
      key("Escape");
      expect(assistantPane()).not.toBeVisible();
      expect(assistantButton()).toHaveFocus();

      fireEvent.click(assistantButton());
      fireEvent.pointerDown(screen.getByRole("button", { name: "Page link" }));
      expect(assistantPane()).not.toBeVisible();
    });

    it("keeps its content's state across closing, reopening and crossing 1280px", () => {
      const setWidth = stubWidth(1280);
      render(<TestShell assistant={<Counter />} initialAssistantOpen />);
      fireEvent.click(screen.getByRole("button", { name: "Count 0" }));

      fireEvent.click(assistantButton());
      fireEvent.click(assistantButton());
      setWidth(1024);
      fireEvent.click(assistantButton());
      expect(screen.getByRole("button", { name: "Count 1" })).toBeVisible();

      setWidth(1280);
      expect(screen.getByRole("button", { name: "Count 1" })).toBeVisible();
    });

    it("is reached by F6 after the page column, and Shift+F6 goes back", () => {
      stubWidth(1280);
      render(
        <TestShell assistant={<button type="button">Settings</button>} initialAssistantOpen />,
      );
      const link = screen.getByRole("button", { name: "Page link" });

      act(() => link.focus());
      key("F6");
      expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
      key("F6");
      expect(screen.getByRole("button", { name: "Tree row" })).toHaveFocus();
      key("F6", { shiftKey: true });
      expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
      key("F6", { shiftKey: true });
      expect(link).toHaveFocus();
    });

    it("moves focus to its button when the pane hides with focus inside", () => {
      stubWidth(1280);
      render(
        <TestShell assistant={<button type="button">Settings</button>} initialAssistantOpen />,
      );
      act(() => screen.getByRole("button", { name: "Settings" }).focus());

      fireEvent.click(assistantButton());

      expect(assistantPane()).not.toBeVisible();
      expect(assistantButton()).toHaveFocus();
    });
  });
});
