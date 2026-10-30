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
