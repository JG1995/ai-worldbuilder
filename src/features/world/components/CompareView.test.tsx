import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import type { DiffLine } from "@/types/api";
import { mockWorldIpc } from "../api/test-ipc";
import { CompareView } from "./CompareView";

const lines: DiffLine[] = [
  { kind: "same", text: "# Kesh" },
  { kind: "removed", text: "Theirs" },
  { kind: "added", text: "Mine" },
];

function renderCompare() {
  const actions = { onKeepMine: vi.fn(), onLoadTheirs: vi.fn(), onClose: vi.fn() };
  const firstActionRef = createRef<HTMLButtonElement>();
  render(
    <CompareView
      firstActionRef={firstActionRef}
      path="Kesh.md"
      text={"# Kesh\nMine\n"}
      {...actions}
    />,
  );
  return { ...actions, firstActionRef };
}

it("shows each line with its marker and colour, removed lines struck through", async () => {
  const calls = mockWorldIpc({ page_compare: () => ({ version: "theirs", lines }) });
  renderCompare();

  const rows = within(await screen.findByRole("list", { name: "Differences" })).getAllByRole(
    "listitem",
  );

  expect(calls.map(({ command, args }) => [command, args])).toEqual([
    ["page_compare", { path: "Kesh.md", text: "# Kesh\nMine\n" }],
  ]);
  expect(rows.map((row) => row.textContent)).toEqual([
    "# Kesh",
    "−Only on disk: Theirs",
    "+Only in your text: Mine",
  ]);
  expect(rows[0]).toHaveClass("text-text-muted");
  expect(rows[1]).toHaveClass("bg-diff-removed");
  expect(within(rows[1]).getByText("−")).toHaveClass("text-error");
  expect(within(rows[1]).getByText("Theirs")).toHaveClass("line-through");
  expect(rows[2]).toHaveClass("bg-diff-added");
  expect(within(rows[2]).getByText("+")).toHaveClass("text-success");
});

it("offers Keep mine, Load theirs and a way back to the editor, with Keep mine first", async () => {
  mockWorldIpc({ page_compare: () => ({ version: "theirs", lines }) });
  const actions = renderCompare();
  const compare = screen.getByRole("region", { name: "Compare" });
  const keepMine = within(compare).getByRole("button", { name: "Keep mine" });

  expect(actions.firstActionRef.current).toBe(keepMine);
  fireEvent.click(keepMine);
  fireEvent.click(within(compare).getByRole("button", { name: "Load theirs" }));
  fireEvent.click(within(compare).getByRole("button", { name: "Back to editing" }));

  expect(actions.onKeepMine).toHaveBeenCalledOnce();
  expect(actions.onLoadTheirs).toHaveBeenCalledOnce();
  expect(actions.onClose).toHaveBeenCalledOnce();
});

it("says why the page on disk cannot be compared", async () => {
  mockWorldIpc({
    page_compare: () => {
      throw { kind: "not_utf8", message: "The page is not UTF-8 text." };
    },
  });
  renderCompare();

  expect(
    await screen.findByText("The page cannot be compared: The page is not UTF-8 text."),
  ).toBeInTheDocument();
});
