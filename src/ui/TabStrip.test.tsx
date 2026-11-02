import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Tab, TabStrip } from "./TabStrip";

const tabs: Tab[] = [
  { id: "saltmere", label: "Saltmere" },
  { id: "thorr", label: "Þórr" },
  { id: "archive", label: "The drowned archive" },
];

function renderStrip(activeId = "thorr") {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  render(<TabStrip tabs={tabs} activeId={activeId} onActivate={onActivate} onClose={onClose} />);
  return { onActivate, onClose };
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("TabStrip", () => {
  beforeEach(() => {
    // jsdom has no layout, so the strip never overflows here; e2e/shell.spec.ts covers overflow.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it("reports an activate request on click and a close request from the close button", () => {
    const { onActivate, onClose } = renderStrip();

    fireEvent.click(tab("Saltmere"));
    fireEvent.click(screen.getByRole("button", { name: "Close The drowned archive" }));

    expect(onActivate).toHaveBeenCalledWith("saltmere");
    expect(onClose).toHaveBeenCalledWith("archive");
  });

  it("shows trailing controls at the strip's end, after the tabs", () => {
    render(
      <TabStrip
        tabs={tabs}
        onActivate={() => {}}
        onClose={() => {}}
        trailing={<button type="button">Assistant</button>}
      />,
    );

    const trailing = screen.getByRole("button", { name: "Assistant" });
    expect(screen.getByRole("tablist").compareDocumentPosition(trailing)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("reports a close request on middle-click", () => {
    const { onActivate, onClose } = renderStrip();

    fireEvent(tab("Saltmere"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(onClose).toHaveBeenCalledWith("saltmere");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl+Tab", { ctrlKey: true }, "archive", "thorr"],
    ["Ctrl+Shift+Tab", { ctrlKey: true, shiftKey: true }, "saltmere", "thorr"],
    ["Ctrl+Tab at the last tab", { ctrlKey: true }, "saltmere", "archive"],
    ["Ctrl+Shift+Tab at the first tab", { ctrlKey: true, shiftKey: true }, "archive", "saltmere"],
    ["Cmd+Tab", { metaKey: true }, "archive", "thorr"],
  ])("%s reports the neighbouring tab, wrapping at the ends", (_, keys, expected, activeId) => {
    const { onActivate } = renderStrip(activeId);

    fireEvent.keyDown(window, { key: "Tab", ...keys });

    expect(onActivate.mock.calls).toEqual([[expected]]);
  });

  it("ignores Ctrl+Tab while focus is inside a modal dialog", () => {
    const { onActivate } = renderStrip();
    render(
      <div role="dialog" aria-modal="true" aria-label="Delete">
        <button type="button">Cancel</button>
      </div>,
    );
    act(() => screen.getByRole("button", { name: "Cancel" }).focus());

    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), {
      key: "Tab",
      ctrlKey: true,
    });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("moves focus with Left and Right without activating, and activates with Enter", () => {
    const { onActivate } = renderStrip();

    act(() => tab("Þórr").focus());
    fireEvent.keyDown(tab("Þórr"), { key: "ArrowRight" });
    expect(tab("The drowned archive")).toHaveFocus();
    fireEvent.keyDown(tab("The drowned archive"), { key: "ArrowRight" });
    expect(tab("Saltmere")).toHaveFocus();
    fireEvent.keyDown(tab("Saltmere"), { key: "ArrowLeft" });
    expect(tab("The drowned archive")).toHaveFocus();
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.keyDown(tab("The drowned archive"), { key: "Enter" });
    expect(onActivate.mock.calls).toEqual([["archive"]]);
  });

  it("marks a tab with changes waiting for review with a dot, a tooltip and its description", () => {
    vi.useFakeTimers();
    const pending = [{ ...tabs[0], pending: true }, tabs[1]];
    render(<TabStrip tabs={pending} onActivate={() => {}} onClose={() => {}} />);
    const shownTooltip = () =>
      screen
        .queryAllByText("Changes waiting for review")
        .filter((element) => !element.closest("[hidden]"));

    expect(tab("Saltmere")).toHaveAccessibleDescription("Changes waiting for review");
    expect(tab("Saltmere").querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(tab("Þórr")).toHaveAccessibleDescription("");
    expect(tab("Þórr").querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();

    fireEvent.pointerEnter(tab("Þórr"));
    act(() => vi.advanceTimersByTime(500));
    expect(shownTooltip()).toEqual([]);
    fireEvent.pointerEnter(tab("Saltmere"));
    act(() => vi.advanceTimersByTime(500));
    expect(shownTooltip()).toHaveLength(1);
    vi.useRealTimers();
  });

  it("makes the focused tab and its close button the strip's tab stops", () => {
    renderStrip();
    const tabStops = () =>
      [...document.querySelectorAll('[tabindex="0"]')].map(
        (element) => element.getAttribute("aria-label") ?? element.textContent,
      );

    expect(tabStops()).toEqual(["Þórr", "Close Þórr"]);
    act(() => tab("Þórr").focus());
    fireEvent.keyDown(tab("Þórr"), { key: "ArrowLeft" });
    expect(tabStops()).toEqual(["Saltmere", "Close Saltmere"]);
  });
});
