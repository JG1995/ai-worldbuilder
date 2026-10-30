import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoPageOpen, PageView } from "./PageView";

describe("PageView", () => {
  it("shows the title and Loading… only after 300ms of loading", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <PageView title="Saltmere" loading>
          Body
        </PageView>,
      );

      act(() => vi.advanceTimersByTime(299));
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Saltmere" })).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Saltmere" })).toBeInTheDocument();
      expect(screen.queryByText("Body")).not.toBeInTheDocument();

      rerender(<PageView title="Saltmere">Body</PageView>);
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
      expect(screen.getByText("Body")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NoPageOpen", () => {
  it("reports New page", () => {
    const onNewPage = vi.fn();
    render(<NoPageOpen onNewPage={onNewPage} />);
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(onNewPage).toHaveBeenCalledOnce();
  });
});
