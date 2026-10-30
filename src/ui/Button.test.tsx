import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button";

afterEach(() => {
  vi.useRealTimers();
});

describe("Button", () => {
  it("shows Working… while loading and ignores clicks until loading ends", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="primary" loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Working…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button variant="primary" onClick={onClick}>
        Save
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("IconButton", () => {
  it("is named by its label and shows its tooltip with the shortcut on focus", () => {
    vi.useFakeTimers();
    render(<IconButton icon="close" label="Close tab" shortcut="Ctrl+W" />);

    const button = screen.getByRole("button", { name: "Close tab" });
    expect(button).toHaveAccessibleDescription("Close tab Ctrl+W");
    act(() => button.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Close tab Ctrl+W");
  });
});
