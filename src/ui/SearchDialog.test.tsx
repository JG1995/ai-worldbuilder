import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PageMatch, TextMatch } from "@/types/api";
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

const arrival: TextMatch = {
  path: "Log/Arrival.md",
  name: "Arrival",
  lines: [
    {
      text: "Mirëla spared the captain, then spared him again.",
      at: 40,
      marks: [
        { from: 7, to: 13 },
        { from: 32, to: 38 },
      ],
    },
    { text: "…the spared crew", at: 120, marks: [{ from: 5, to: 11 }] },
  ],
};
const departure: TextMatch = {
  path: "Departure.md",
  name: "Departure",
  lines: [{ text: "Nobody spared a thought.", at: 7, marks: [{ from: 7, to: 13 }] }],
};

const ready = (
  query: string,
  pages: PageMatch[],
  create = false,
  texts: TextMatch[] = [],
  pending = false,
): SearchResults => ({ state: "ready", query, pages, create, texts, pending });

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
    expect(box).toHaveAttribute("placeholder", "Search pages by name, alias or text");
    const listbox = screen.getByRole("listbox");
    expect(box).toHaveAttribute("aria-controls", listbox.id);
    expect(box).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("2 pages match.");
    // WebKit leaves out what is outside a modal dialog, so the live region is inside it.
    expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("status"));
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
      results: {
        state: "building",
        query: "mir",
        pages: [mirela],
        create: false,
        texts: [],
        pending: false,
      },
    });
    expect(screen.getByText("Indexing world…")).toBeInTheDocument();
    expect(options()).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing world… 1 page matches.");

    rerender({ results: { state: "failed", query: "mir", message: "Permission denied." } });
    expect(
      within(screen.getByRole("dialog")).getByText("Pages cannot be searched: Permission denied.", {
        ignore: "[role=status]",
      }),
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

  it("lists each text match after the page matches as a group named by its page, with every matched word underlined", () => {
    renderDialog({ results: ready("spared", [mirela], false, [arrival, departure]) });

    const [first, second] = screen.getAllByRole("group");
    expect(first).toHaveAccessibleName("Arrival, Log");
    expect(second).toHaveAccessibleName("Departure");
    // The labels are not rows: the page match, then the three lines.
    expect(options().map((option) => option.textContent)).toEqual([
      "MirëlaPeople",
      "Mirëla spared the captain, then spared him again.",
      "…the spared crew",
      "Nobody spared a thought.",
    ]);
    expect(within(first).getAllByRole("option")).toHaveLength(2);
    expect(first).toHaveTextContent(/^ArrivalLog/);
    const marks = within(options()[1]).getAllByText("spared");
    expect(marks).toHaveLength(2);
    for (const mark of marks) expect(mark).toHaveClass("underline");
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 page matches. 2 pages match by their text.",
    );
  });

  it("moves through page rows and lines alike, and picks a line with where its match is", () => {
    const { props } = renderDialog({
      results: ready("spared", [mirela], false, [arrival, departure]),
    });

    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toHaveTextContent("…the spared crew");
    press("Enter");
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toHaveTextContent("Nobody spared a thought.");
    press("Enter", { ctrlKey: true });
    fireEvent.click(options()[1]);

    expect(vi.mocked(props.onPick).mock.calls).toEqual([
      [{ kind: "line", path: arrival.path, at: 120 }, { newTab: false }],
      [{ kind: "line", path: departure.path, at: 7 }, { newTab: true }],
      [{ kind: "line", path: arrival.path, at: 40 }, { newTab: false }],
    ]);
  });

  it("keeps the selected line for a new answer to the same query while it is still listed", () => {
    const { rerender } = renderDialog({ results: ready("spared", [], true, [arrival]) });
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toHaveTextContent("…the spared crew");

    rerender({ results: ready("spared", [], true, [departure, arrival]) });
    expect(selected()).toHaveTextContent("…the spared crew");

    rerender({ results: ready("spared", [], true, [departure]) });
    expect(selected()).toHaveTextContent('Create page "spared"');
  });

  it("says that nothing matches only once no text answer is on its way", () => {
    const { rerender } = renderDialog({
      query: "Harbor",
      results: ready("Harbor", [], true, [], true),
    });
    expect(screen.queryByText('Nothing matches "Harbor".')).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/^Create page "Harbor".$/);

    rerender({ results: ready("Harbor", [], true, [], false) });
    expect(screen.getByText('Nothing matches "Harbor".')).toBeInTheDocument();
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
