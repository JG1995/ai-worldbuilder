import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeInViewport, Tooltip } from "./Tooltip";

afterEach(() => {
  vi.useRealTimers();
});

function renderTooltip() {
  render(
    <Tooltip text="Export world">
      {(describedBy) => (
        <button type="button" aria-describedby={describedBy}>
          Export
        </button>
      )}
    </Tooltip>,
  );
  return screen.getByRole("button", { name: "Export" });
}

describe("Tooltip", () => {
  it("shows after a delay on hover and closes when the pointer leaves", () => {
    vi.useFakeTimers();
    const trigger = renderTooltip();

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Export world");

    fireEvent.pointerLeave(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes on Escape and on blur", () => {
    vi.useFakeTimers();
    const trigger = renderTooltip();

    act(() => trigger.focus());
    act(() => vi.advanceTimersByTime(500));
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => trigger.blur());
    act(() => trigger.focus());
    act(() => vi.advanceTimersByTime(500));
    act(() => trigger.blur());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("placeInViewport", () => {
  const viewport = { width: 800, height: 600 };
  const size = { width: 120, height: 30 };

  it("centres the popover below its anchor", () => {
    const anchor = { left: 300, right: 340, top: 100, bottom: 128 };
    expect(placeInViewport(size, anchor, "center", viewport)).toEqual({ left: 260, top: 132 });
  });

  it("flips above the anchor and stays inside the viewport near its edges", () => {
    const anchor = { left: 760, right: 790, top: 570, bottom: 598 };
    expect(placeInViewport(size, anchor, "start", viewport)).toEqual({ left: 672, top: 536 });
  });
});
