import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TreeEntry } from "@/types/api";
import { FileTree } from "./FileTree";

const entries: TreeEntry[] = [
  {
    path: "Places",
    name: "Places",
    kind: "folder",
    children: [
      { path: "Places/Saltmere.md", name: "Saltmere", kind: "page" },
      {
        path: "Places/North",
        name: "North",
        kind: "folder",
        children: [{ path: "Places/North/Þórr.md", name: "Þórr", kind: "page" }],
      },
    ],
  },
  { path: "Ærøskøbing.md", name: "Ærøskøbing", kind: "page" },
];

type Props = ComponentProps<typeof FileTree>;

function renderTree(overrides: Partial<Props> = {}) {
  const props: Props = {
    worldName: "Saltmere",
    entries,
    expanded: new Set(["Places"]),
    worldMenuItems: [{ id: "close", label: "Close world" }],
    onWorldMenuSelect: vi.fn(),
    contextMenuItems: vi.fn(() => [
      { id: "open", label: "Open in new tab" },
      { id: "rename", label: "Rename" },
    ]),
    onContextMenuSelect: vi.fn(),
    onOpen: vi.fn(),
    onToggle: vi.fn(),
    onNewPage: vi.fn(),
    onNewFolder: vi.fn(),
    onNameSubmit: vi.fn(),
    onNameCancel: vi.fn(),
    ...overrides,
  };
  render(<FileTree {...props} />);
  return props;
}

const row = (name: string) => screen.getByRole("treeitem", { name });

function focusRow(name: string) {
  act(() => row(name).focus());
}

function press(key: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(document.activeElement as Element, { key, ...init });
}

describe("FileTree", () => {
  it("renders only expanded folders' children, with their level, state and selection", () => {
    renderTree({ selected: "Places/Saltmere.md" });

    expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Places"),
      expect.stringContaining("Saltmere"),
      expect.stringContaining("North"),
      expect.stringContaining("Ærøskøbing"),
    ]);
    expect(screen.queryByRole("treeitem", { name: "Þórr" })).not.toBeInTheDocument();
    expect(row("Places")).toHaveAttribute("aria-expanded", "true");
    expect(row("North")).toHaveAttribute("aria-expanded", "false");
    expect(row("North")).toHaveAttribute("aria-level", "2");
    expect(row("Saltmere")).toHaveAttribute("aria-selected", "true");
    expect(row("Ærøskøbing")).toHaveAttribute("aria-selected", "false");
  });

  it("moves focus with Up, Down, Home and End, and makes the focused row the only tab stop", () => {
    renderTree();
    focusRow("Places");

    press("ArrowDown");
    expect(row("Saltmere")).toHaveFocus();
    press("ArrowDown");
    press("ArrowDown");
    expect(row("Ærøskøbing")).toHaveFocus();
    press("ArrowDown");
    expect(row("Ærøskøbing")).toHaveFocus();
    press("ArrowUp");
    expect(row("North")).toHaveFocus();
    press("Home");
    expect(row("Places")).toHaveFocus();
    press("End");
    expect(row("Ærøskøbing")).toHaveFocus();
    expect(screen.getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toEqual([
      row("Ærøskøbing"),
    ]);
  });

  it("reports an expand request on Right for a collapsed folder and moves into an expanded one", () => {
    const { onToggle } = renderTree();

    focusRow("North");
    press("ArrowRight");
    expect(onToggle).toHaveBeenCalledWith("Places/North", true);
    expect(row("North")).toHaveFocus();

    focusRow("Places");
    press("ArrowRight");
    expect(row("Saltmere")).toHaveFocus();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reports a collapse request on Left for an expanded folder and moves to the parent", () => {
    const { onToggle } = renderTree();

    focusRow("Places");
    press("ArrowLeft");
    expect(onToggle).toHaveBeenCalledWith("Places", false);
    expect(row("Places")).toHaveFocus();

    focusRow("North");
    press("ArrowLeft");
    expect(row("Places")).toHaveFocus();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("opens a page and toggles a folder on Enter, and ignores F2 and Delete", () => {
    const { onOpen, onToggle } = renderTree();

    focusRow("Saltmere");
    press("Enter");
    press("F2");
    press("Delete");
    focusRow("North");
    press("Enter");

    expect(onOpen).toHaveBeenCalledExactlyOnceWith("Places/Saltmere.md", { newTab: false });
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("Places/North", true);
  });

  it("reports opening in the current tab on click, and in a new tab on Ctrl+click and middle-click", () => {
    const { onOpen, onToggle } = renderTree();

    fireEvent.click(row("Saltmere"));
    fireEvent.click(row("Saltmere"), { ctrlKey: true });
    fireEvent.click(row("Saltmere"), { metaKey: true });
    fireEvent(row("Saltmere"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    fireEvent.click(row("Places"));

    expect(vi.mocked(onOpen).mock.calls).toEqual([
      ["Places/Saltmere.md", { newTab: false }],
      ["Places/Saltmere.md", { newTab: true }],
      ["Places/Saltmere.md", { newTab: true }],
      ["Places/Saltmere.md", { newTab: true }],
    ]);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("Places", false);
  });

  it("opens the caller's items for the focused row on Shift+F10, and menu keys stay in the menu", () => {
    const { contextMenuItems, onContextMenuSelect, onToggle } = renderTree();

    focusRow("North");
    press("F10", { shiftKey: true });

    expect(contextMenuItems).toHaveBeenCalledWith(entries[0].children?.[1]);
    expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toHaveFocus();
    press("ArrowDown");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    press("ArrowRight");
    press("Enter");

    expect(onToggle).not.toHaveBeenCalled();
    expect(onContextMenuSelect).toHaveBeenCalledWith("rename", entries[0].children?.[1]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row("North")).toHaveFocus();
  });

  it("closes a Shift+F10 menu on a press on its own row and returns focus to the row", () => {
    const { onToggle } = renderTree();

    focusRow("North");
    press("F10", { shiftKey: true });
    fireEvent.pointerDown(row("North"));
    fireEvent.click(row("North"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row("North")).toHaveFocus();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("opens a Shift+F10 menu above a row near the bottom instead of covering it", () => {
    renderTree();
    // jsdom's viewport is 768 pixels tall, so the menu does not fit below this row.
    vi.spyOn(row("North"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 740, 200, 24));

    focusRow("North");
    press("F10", { shiftKey: true });

    expect(Number.parseFloat(screen.getByRole("menu").style.top)).toBeLessThan(740);
  });

  it("opens the caller's empty-space items on a right-click outside the rows", () => {
    const { contextMenuItems } = renderTree();

    fireEvent.contextMenu(screen.getByRole("tree").parentElement as Element);

    expect(contextMenuItems).toHaveBeenCalledWith(null);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("reports the typed name on Enter and a cancel on Escape, showing the caller's error", () => {
    const error = 'A page named "Saltmere" already exists.';
    const { onNameSubmit, onNameCancel } = renderTree({
      nameInput: { folder: "Places", kind: "page", error },
    });
    const input = screen.getByRole("textbox", { name: "New page name" });

    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(error);
    // The input sits at the top of its folder.
    expect(row("Places").nextElementSibling).toContainElement(input);

    fireEvent.change(input, { target: { value: "Saltmere" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onNameSubmit).toHaveBeenCalledExactlyOnceWith("Saltmere");
    expect(onNameCancel).toHaveBeenCalledOnce();
    expect(input).toHaveFocus();
  });

  it("shows the caller's shortcuts in the New page and New folder tooltips", () => {
    renderTree({ newPageShortcut: "Ctrl+N", newFolderShortcut: "Ctrl+Shift+N" });

    expect(screen.getByRole("button", { name: "New page" })).toHaveAccessibleDescription(
      "New page Ctrl+N",
    );
    expect(screen.getByRole("button", { name: "New folder" })).toHaveAccessibleDescription(
      "New folder Ctrl+Shift+N",
    );
  });

  it("shows the empty state with a New page button when the world has no entries", () => {
    const { onNewPage } = renderTree({ entries: [] });

    const message = screen.getByText("This world has no pages yet.");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    fireEvent.click(
      within(message.parentElement as HTMLElement).getByRole("button", { name: "New page" }),
    );
    expect(onNewPage).toHaveBeenCalledOnce();
  });
});
