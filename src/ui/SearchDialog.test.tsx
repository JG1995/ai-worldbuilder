import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PageMatch } from "@/types/api";
import { SearchDialog, type SearchResults } from "./SearchDialog";

const mirela: PageMatch = {
  path: "People/Mirëla.md",
  name: "Mirëla",
  field: "name",
  alias: null,
  mark: { from: 0, to: 3 },
};
const keshTor: PageMatch = {
  path: "Kesh Tor.md",
  name: "Kesh Tor",
  field: "alias",
  alias: "Old Mire",
  mark: { from: 4, to: 7 },
};
const saltmere: PageMatch = {
  path: "Lore/Saltmere.md",
  name: "Saltmere",
  field: "path",
  alias: null,
  mark: { from: 3, to: 8 },
};

const ready = (query: string, pages: PageMatch[], create = false): SearchResults => ({
  state: "ready",
  query,
  pages,
  create,
});

type Props = ComponentProps<typeof SearchDialog>;

/** Renders the dialog from a button that had focus, which it returns focus to on close. */
function renderDialog(overrides: Partial<Props> = {}) {
  const props: Props = {
    query: "mir",
    onQueryChange: vi.fn(),
    results: ready("mir", [mirela, keshTor]),
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const view = render(<SearchDialog {...props} />);
  const rerender = (next: Partial<Props>) => view.rerender(<SearchDialog {...props} {...next} />);
  return { props, opener, rerender, unmount: view.unmount };
}

const input = () => screen.getByRole("combobox", { name: "Search pages" });
const options = () => screen.getAllByRole("option");
const selected = () => screen.getByRole("option", { selected: true });
const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(input(), { key, ...init });

describe("SearchDialog", () => {
  it("opens with focus in a combobox that controls the listbox of matching pages", () => {
    renderDialog();

    const box = input();
    expect(box).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Search pages" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("placeholder", "Search pages by name or alias");
    const listbox = screen.getByRole("listbox");
    expect(box).toHaveAttribute("aria-controls", listbox.id);
    expect(box).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("2 pages match.");
  });

  it("shows each page's name, folder and alias with the matched characters underlined", () => {
    renderDialog({ results: ready("e/sal", [mirela, keshTor, saltmere]) });

    const [byName, byAlias, byPath] = options();
    expect(byName).toHaveTextContent(/^MirëlaPeople$/);
    expect(within(byName).getByText("Mir")).toHaveClass("underline");
    expect(byAlias).toHaveTextContent(/^Kesh Toralias: Old Mire$/);
    expect(within(byAlias).getByText("Mir")).toHaveClass("underline");
    // A path match marks across the folder and the name.
    expect(byPath).toHaveTextContent(/^SaltmereLore$/);
    expect(within(byPath).getByText("e")).toHaveClass("underline");
    expect(within(byPath).getByText("Sal")).toHaveClass("underline");
  });

  it("offers to create the page and says when nothing matches", () => {
    renderDialog({ query: "Harbor", results: ready("Harbor", [], true) });

    expect(screen.getByText('Nothing matches "Harbor".')).toBeInTheDocument();
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('Create page "Harbor"');
    expect(selected()).toHaveTextContent('Create page "Harbor"');
    expect(screen.getByRole("status")).toHaveTextContent(
      'Nothing matches "Harbor". Create page "Harbor".',
    );
  });

  it("says while the world is indexed, when pages cannot be searched, and why a page was not created", () => {
    const { rerender } = renderDialog({
      results: { state: "building", query: "mir", pages: [mirela], create: false },
    });
    expect(screen.getByText("Indexing world…")).toBeInTheDocument();
    expect(options()).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing world… 1 page matches.");

    rerender({ results: { state: "failed", query: "mir", message: "Permission denied." } });
    expect(
      within(screen.getByRole("dialog")).getByText("Pages cannot be searched: Permission denied."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pages cannot be searched: Permission denied.",
    );
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(input()).toHaveAttribute("aria-expanded", "false");

    rerender({ results: ready("CON", [], true), createError: "Windows reserves CON." });
    expect(input()).toHaveAccessibleDescription("Windows reserves CON.");
    expect(input()).toHaveAttribute("aria-invalid", "true");
  });

  it("lists nothing and says nothing for an empty query", () => {
    renderDialog({ query: "", results: null });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("moves the selection with Up and Down, stopping at the ends, and picks with Enter", () => {
    const { props } = renderDialog({ results: ready("mir", [mirela, keshTor], false) });

    press("ArrowUp");
    expect(selected()).toBe(options()[0]);
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toBe(options()[1]);
    expect(input()).toHaveAttribute("aria-activedescendant", options()[1].id);

    press("Enter");
    press("Enter", { ctrlKey: true });
    press("Enter", { metaKey: true });
    expect(vi.mocked(props.onPick).mock.calls).toEqual([
      [{ kind: "page", path: "Kesh Tor.md" }, { newTab: false }],
      [{ kind: "page", path: "Kesh Tor.md" }, { newTab: true }],
      [{ kind: "page", path: "Kesh Tor.md" }, { newTab: true }],
    ]);
    expect(input()).toHaveFocus();
  });

  it("picks a row with a click, in a new tab with Ctrl or Cmd or a middle click", () => {
    const { props } = renderDialog({ results: ready("Harbor", [mirela], true) });
    const [page, create] = options();

    fireEvent.click(page);
    fireEvent.click(page, { ctrlKey: true });
    fireEvent(page, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    fireEvent.click(create);
    expect(vi.mocked(props.onPick).mock.calls).toEqual([
      [{ kind: "page", path: mirela.path }, { newTab: false }],
      [{ kind: "page", path: mirela.path }, { newTab: true }],
      [{ kind: "page", path: mirela.path }, { newTab: true }],
      [{ kind: "create" }, { newTab: false }],
    ]);
  });

  it("keeps the window's shortcuts from seeing the keys it handles, Tab among them", () => {
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    renderDialog();

    const tab = press("Tab");
    press("Escape");
    window.removeEventListener("keydown", seen);

    expect(tab).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to where it was", () => {
    const { props, opener } = renderDialog();

    press("Escape");

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  });

  it("closes on a press on the backdrop, whose click then reaches nothing", () => {
    const { props, opener } = renderDialog();
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    const clicked = vi.fn();
    document.body.addEventListener("click", clicked);

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop, { button: 0 });
    fireEvent.click(document.body);
    document.body.removeEventListener("click", clicked);

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("leaves focus in place when a row is picked", () => {
    const { opener } = renderDialog();

    press("Enter");

    expect(opener).not.toHaveFocus();
  });

  it("selects the first row of a new query's answer and keeps the selected page for the same query", () => {
    const { rerender } = renderDialog({ results: ready("mir", [mirela, keshTor]) });
    press("ArrowDown");
    expect(selected()).toHaveTextContent("Kesh Tor");

    // The index changed: the same query's new answer still lists Kesh Tor, now first.
    rerender({ results: ready("mir", [keshTor, saltmere, mirela]) });
    expect(selected()).toHaveTextContent("Kesh Tor");

    // Kesh Tor is gone from the next answer to the same query.
    rerender({ results: ready("mir", [saltmere, mirela]) });
    expect(selected()).toHaveTextContent("Saltmere");
    press("ArrowDown");

    rerender({ query: "mire", results: ready("mire", [saltmere, mirela]) });
    expect(selected()).toHaveTextContent("Saltmere");
  });

  it("reports what is typed", () => {
    const { props } = renderDialog();

    act(() => {
      fireEvent.change(input(), { target: { value: "mira" } });
    });

    expect(props.onQueryChange).toHaveBeenCalledWith("mira");
  });
});
