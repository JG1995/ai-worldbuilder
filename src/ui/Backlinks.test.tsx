import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Backlinks as BacklinksState } from "@/types/api";
import { Backlinks } from "./Backlinks";

const ready: BacklinksState = {
  state: "ready",
  pages: [
    { path: "People/Mirela.md", name: "Mirela", line: "Sails to [[Saltmere]].", at: 9 },
    { path: "Archive/Session 2.md", name: "Session 2", line: "At [[Saltmere]].", at: 3 },
    { path: "Sessions/session 2.md", name: "session 2", line: "Back in [[Saltmere]].", at: 8 },
  ],
};

function renderBacklinks(backlinks: BacklinksState) {
  const onOpen = vi.fn();
  render(<Backlinks backlinks={backlinks} onOpen={onOpen} />);
  return onOpen;
}

const section = () => screen.getByRole("region", { name: /Linked from/ });

describe("Backlinks", () => {
  it("lists each page with its line and count, and a folder only where names are shared", () => {
    renderBacklinks(ready);

    expect(screen.getByRole("heading")).toHaveTextContent("Linked from3");
    const [mirela, archived, session] = within(section()).getAllByRole("button");
    expect(mirela).toHaveTextContent(/^MirelaSails to \[\[Saltmere\]\]\.$/);
    expect(archived).toHaveTextContent(/^Session 2ArchiveAt/);
    expect(session).toHaveTextContent(/^session 2SessionsBack in/);
  });

  it("says when no page links here, while the index is built, and why it cannot be built", () => {
    const { rerender } = render(
      <Backlinks backlinks={{ state: "ready", pages: [] }} onOpen={vi.fn()} />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Linked from0");
    expect(section()).toHaveTextContent("No pages link here yet.");

    rerender(<Backlinks backlinks={{ state: "building" }} onOpen={vi.fn()} />);
    expect(screen.getByRole("heading")).toHaveTextContent(/^Linked from$/);
    expect(section()).toHaveTextContent("Indexing world…");

    rerender(
      <Backlinks backlinks={{ state: "failed", message: "Permission denied." }} onOpen={vi.fn()} />,
    );
    expect(section()).toHaveTextContent("Backlinks cannot be shown: Permission denied.");
    expect(within(section()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens a row here on a click or Enter, and in a new tab with Ctrl/Cmd or the middle button", () => {
    const onOpen = renderBacklinks(ready);
    const row = within(section()).getAllByRole("button")[0];
    const here = ["People/Mirela.md", 9, { newTab: false }];
    const newTab = ["People/Mirela.md", 9, { newTab: true }];

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.click(row, { ctrlKey: true });
    fireEvent.click(row, { metaKey: true });
    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    fireEvent.keyDown(row, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(row, { key: "Enter", metaKey: true });

    expect(onOpen.mock.calls).toEqual([here, here, newTab, newTab, newTab, newTab, newTab]);
  });
});
