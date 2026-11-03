import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWorldIpc, shellLayout } from "../api/test-ipc";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";

type Handler = Parameters<typeof mockWorldIpc>[0];

/** Opens the test world and its Overview page in the shell as AI off lays it out. */
async function openOverview(overrides: Handler = {}) {
  const calls = mockWorldIpc(overrides);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <World layout={shellLayout} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "Overview" }));
  return { calls };
}

const switchKey = (target: Element = document.activeElement ?? document.body) =>
  fireEvent.keyDown(target, { key: "e", ctrlKey: true });
const viewButton = () => screen.getByRole("button", { name: /^(Reading|Editing) view$/ });
const readingRegion = () => screen.queryByRole("region", { name: "Overview" });
const editable = (textbox: HTMLElement) =>
  EditorView.findFromDOM(textbox)?.state.facet(EditorView.editable);
const treeButton = () => screen.queryByRole("button", { name: "File tree" });

beforeEach(() => {
  useWorldStore.getState().closed();
  // jsdom has no layout: the shell lays out as at 1280px and wider.
  const wide = { matches: true, addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("matchMedia", () => wide);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe("switching views", () => {
  it("Ctrl/Cmd+E switches the active tab and keeps focus in the page, with the reading layout's tree collapsed", async () => {
    await openOverview();
    const textbox = await screen.findByRole("textbox", { name: "Overview" });
    act(() => textbox.focus());
    expect(treeButton()).not.toBeInTheDocument();

    switchKey(textbox);

    expect(editable(textbox)).toBe(false);
    expect(readingRegion()).toHaveFocus();
    expect(viewButton()).toHaveAccessibleName("Editing view");
    expect(treeButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary", { hidden: true })).not.toBeVisible();

    switchKey();

    expect(editable(textbox)).toBe(true);
    expect(textbox).toHaveFocus();
    expect(readingRegion()).not.toBeInTheDocument();
    expect(treeButton()).not.toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Kesh" })).toBeVisible();
  });

  it("switches with the view button, which keeps focus, and from the tree, which moves focus to the page as it collapses", async () => {
    await openOverview();
    const textbox = await screen.findByRole("textbox", { name: "Overview" });
    expect(viewButton()).toHaveAccessibleName("Reading view");

    act(() => viewButton().focus());
    fireEvent.click(viewButton());
    expect(editable(textbox)).toBe(false);
    expect(viewButton()).toHaveFocus();
    fireEvent.click(viewButton());
    expect(editable(textbox)).toBe(true);

    const row = screen.getByRole("treeitem", { name: "Overview" });
    act(() => row.focus());
    switchKey(row);
    expect(editable(textbox)).toBe(false);
    expect(readingRegion()).toHaveFocus();
  });

  it("has the view button, and no Assistant button, with AI off", async () => {
    await openOverview();
    await screen.findByRole("textbox", { name: "Overview" });

    const strip = viewButton().parentElement as HTMLElement;
    expect(within(strip).getAllByRole("button")).toEqual([viewButton()]);
    expect(screen.queryByRole("button", { name: "Assistant" })).not.toBeInTheDocument();
  });
});

describe("the view switch is refused", () => {
  /** Expects Ctrl/Cmd+E to leave the Overview tab in the editing view, with the button disabled. */
  const expectRefused = () => {
    expect(viewButton()).toBeDisabled();
    switchKey();
    expect(useWorldStore.getState().reading.size).toBe(0);
  };

  it("with no page tab and for a page with no text", async () => {
    mockWorldIpc({
      page_read: () => {
        throw { kind: "not_utf8", message: "Not UTF-8." };
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <World layout={shellLayout} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
    await screen.findByRole("treeitem", { name: "Overview" });
    expectRefused();

    fireEvent.click(screen.getByRole("treeitem", { name: "Overview" }));
    await screen.findByText(/This page is not UTF-8 text/);
    expectRefused();
  });

  it("during a world change and in a modal dialog", async () => {
    await openOverview();
    const textbox = await screen.findByRole("textbox", { name: "Overview" });

    act(() => useWorldStore.getState().setChangingWorld(true));
    expectRefused();
    act(() => useWorldStore.getState().setChangingWorld(false));
    expect(viewButton()).toBeEnabled();

    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    dialog.append(document.createElement("button"));
    document.body.append(dialog);
    act(() => dialog.querySelector("button")?.focus());
    switchKey();
    expect(editable(textbox)).toBe(true);
    dialog.remove();
  });

  it("while the History view or Compare shows, and the tab returns to its view after", async () => {
    let writes = 0;
    await openOverview({
      page_read: () =>
        writes === 0
          ? { text: "# Overview\n", version: "mine" }
          : { text: "# Overview changed elsewhere\n", version: "theirs" },
      page_write: () => {
        if (++writes === 1) throw { kind: "conflict", message: "The page changed on disk." };
        return { version: "saved" };
      },
    });
    const textbox = await screen.findByRole("textbox", { name: "Overview" });
    fireEvent.click(viewButton());
    fireEvent.keyDown(textbox, { key: "h", ctrlKey: true, shiftKey: true });
    await screen.findByRole("region", { name: "History" });
    expect(viewButton()).toBeDisabled();
    switchKey();
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    expect(readingRegion()).toBeInTheDocument();
    fireEvent.click(viewButton());

    const view = EditorView.findFromDOM(textbox) as EditorView;
    act(() =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "Mine" },
        userEvent: "input.type",
      }),
    );
    await act(() => useWorldStore.getState().flush("Overview.md"));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Compare" }));
    await screen.findByRole("region", { name: "Compare" });
    expectRefused();
    await waitFor(() => expect(viewButton()).toBeDisabled());
  });
});
