import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type RecentWorld, WelcomeScreen } from "./WelcomeScreen";

const recent: RecentWorld[] = [
  { id: "1", name: "Saltmere", path: "/home/gm/worlds/Saltmere", missing: false },
  { id: "2", name: "Ærøskøbing", path: "/mnt/old-drive/Ærøskøbing", missing: true },
];

function renderWelcome(worlds: RecentWorld[]) {
  const props = {
    onOpenWorld: vi.fn(),
    onNewWorld: vi.fn(),
    onChooseRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
  };
  render(<WelcomeScreen recentWorlds={worlds} {...props} />);
  return props;
}

describe("WelcomeScreen", () => {
  it("marks a missing world as not found, and Remove reports its id", () => {
    const { onRemoveRecent, onChooseRecent } = renderWelcome(recent);
    const [present, missing] = screen.getAllByRole("listitem");

    expect(within(present).queryByText("Not found")).not.toBeInTheDocument();
    expect(within(present).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(within(missing).getByText("Not found")).toBeInTheDocument();

    fireEvent.click(within(missing).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(present).getByRole("button", { name: /Saltmere/ }));
    expect(onRemoveRecent).toHaveBeenCalledExactlyOnceWith("2");
    expect(onChooseRecent).toHaveBeenCalledExactlyOnceWith("1");
  });

  it("says there are no worlds yet when the recent list is empty", () => {
    renderWelcome([]);
    expect(screen.getByText("No worlds yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
