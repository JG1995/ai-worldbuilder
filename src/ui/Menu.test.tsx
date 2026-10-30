import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Menu, MenuButton, type MenuItem } from "./Menu";

const items: MenuItem[] = [
  { id: "open", label: "Open in new tab", shortcut: "Ctrl+Enter" },
  { id: "duplicate", label: "Duplicate", disabled: true },
  { id: "rename", label: "Rename", shortcut: "F2" },
  { id: "delete", label: "Delete", destructive: true },
];

/** A row that opens the menu on request, as a context menu caller would. */
function ContextMenuRow({ onSelect }: { onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Saltmere
      </button>
      <button type="button">Elsewhere</button>
      {open && (
        <Menu
          label="Page actions"
          items={items}
          at={{ x: 10, y: 10 }}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function openMenu(onSelect = vi.fn()) {
  render(<ContextMenuRow onSelect={onSelect} />);
  const row = screen.getByRole("button", { name: "Saltmere" });
  act(() => row.focus());
  fireEvent.click(row);
  return { row, onSelect };
}

function key(name: string) {
  fireEvent.keyDown(screen.getByRole("menu"), { key: name });
}

describe("Menu", () => {
  it("moves between enabled items with Up, Down, Home and End", () => {
    openMenu();
    const item = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });

    expect(item("Open in new tab")).toHaveFocus();
    key("ArrowDown");
    expect(item("Rename")).toHaveFocus();
    key("End");
    expect(item("Delete")).toHaveFocus();
    key("ArrowDown");
    expect(item("Open in new tab")).toHaveFocus();
    key("ArrowUp");
    expect(item("Delete")).toHaveFocus();
    key("Home");
    expect(item("Open in new tab")).toHaveFocus();
  });

  it("activates the focused item with Enter, closes and returns focus", () => {
    const { row, onSelect } = openMenu();

    key("ArrowDown");
    key("Enter");

    expect(onSelect).toHaveBeenCalledWith("rename");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("closes on Escape and on a click outside, returning focus each time", () => {
    const { row } = openMenu();
    key("Escape");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();

    fireEvent.click(row);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });
});

describe("MenuButton", () => {
  it("reports its state and toggles its menu", () => {
    render(<MenuButton icon="more_horiz" label="World actions" items={items} onSelect={vi.fn()} />);
    const button = screen.getByRole("button", { name: "World actions" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(screen.getByRole("menu", { name: "World actions" })).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");

    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
