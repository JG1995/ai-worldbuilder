import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Toast, ToastRegion } from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const saved: Toast = { id: "saved", message: 'Saved "Saltmere"', action: "Undo" };

describe("ToastRegion", () => {
  it("is a polite status region", () => {
    render(<ToastRegion toasts={[saved]} onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("reports a toast dismissed after 6 seconds", () => {
    const onDismiss = vi.fn();
    render(<ToastRegion toasts={[saved]} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(5999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledWith("saved");
  });

  it("pauses while hovered or focused and restarts 6 seconds after both leave", () => {
    const onDismiss = vi.fn();
    render(<ToastRegion toasts={[saved]} onDismiss={onDismiss} />);
    const toast = screen.getByRole("listitem");
    const undo = screen.getByRole("button", { name: "Undo" });

    act(() => vi.advanceTimersByTime(5000));
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(10_000));
    act(() => undo.focus());
    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => undo.blur());
    act(() => vi.advanceTimersByTime(5999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledWith("saved");
  });

  it("reports the oldest dismissed when a fourth toast arrives and shows the newest three", () => {
    const onDismiss = vi.fn();
    const toasts = ["one", "two", "three", "four"].map((id) => ({ id, message: `Toast ${id}` }));
    render(<ToastRegion toasts={toasts} onDismiss={onDismiss} />);

    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("one");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Toast two",
      "Toast three",
      "Toast four",
    ]);
  });
});
