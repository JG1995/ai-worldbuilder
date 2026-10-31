import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../lib/ipc";
import { NewWorldDialog } from "./NewWorldDialog";
import { useWorldStore } from "./store";
import { mockWorldIpc, testLocation, testWorld } from "./test-ipc";
import { World } from "./World";

const nameInput = () => screen.getByRole("textbox", { name: "Name" });
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));

function typeName(name: string) {
  fireEvent.change(nameInput(), { target: { value: name } });
}

const commandsOf = (calls: { command: string }[]) => calls.map(({ command }) => command);

beforeEach(() => {
  useWorldStore.getState().closed();
  const wide = { matches: true, addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("matchMedia", () => wide);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe("NewWorldDialog", () => {
  it("shows the default location, and Browse… shows the folder picked instead", async () => {
    mockWorldIpc({ world_new_browse: () => ({ location: "/srv/campaigns" }) });
    render(<NewWorldDialog onCreate={vi.fn()} onCancel={vi.fn()} />);

    const location = await screen.findByRole("group", { name: "Location" });
    await waitFor(() => expect(location).toHaveTextContent(testLocation));
    fireEvent.click(within(location).getByRole("button", { name: "Browse…" }));

    await waitFor(() => expect(location).toHaveTextContent("/srv/campaigns"));
  });

  it("reports Create with the name, shows name errors under the input and others below, and stays open", async () => {
    mockWorldIpc();
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce(
        new IpcError("exists", "Something with this name already exists here."),
      )
      .mockResolvedValueOnce(new IpcError("io", "Permission denied."));
    render(<NewWorldDialog onCreate={onCreate} onCancel={vi.fn()} />);
    typeName("Saltmere");

    create();
    await waitFor(() =>
      expect(nameInput()).toHaveAccessibleDescription(
        "Something with this name already exists here.",
      ),
    );
    // Enter in the name input submits too.
    fireEvent.submit(nameInput());

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied.");
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
    expect(onCreate.mock.calls).toEqual([["Saltmere"], ["Saltmere"]]);
    expect(screen.getByRole("dialog", { name: "New world" })).toBeInTheDocument();
  });
});

function renderWorld() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <World />
    </QueryClientProvider>,
  );
}

function typeAtEnd(textbox: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}

/** Opens the test world, types in its Overview page, and starts New world… from the world menu. */
async function editThenStartNewWorld() {
  renderWorld();
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "Overview" }));
  typeAtEnd(await screen.findByRole("textbox", { name: "Overview" }), "More");
  fireEvent.click(screen.getByRole("button", { name: "World menu" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "New world…" }));
  await screen.findByRole("dialog", { name: "New world" });
  typeName("Saltmere");
}

describe("New world", () => {
  it("creates and opens an empty world from the welcome screen", async () => {
    const calls = mockWorldIpc({ world_tree: () => [] });
    renderWorld();

    fireEvent.click(await screen.findByRole("button", { name: "New world…" }));
    await screen.findByRole("dialog", { name: "New world" });
    typeName("Saltmere");
    create();

    expect(await screen.findByText("This world has no pages yet.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Saltmere" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.find(({ command }) => command === "world_create")?.args).toEqual({
      name: "Saltmere",
    });
  });

  it("saves an edit still waiting for autosave before the world is created", async () => {
    const calls = mockWorldIpc();
    await editThenStartNewWorld();

    create();

    await screen.findByRole("heading", { name: "Saltmere" });
    const commands = commandsOf(calls);
    expect(commands.indexOf("page_write")).toBeGreaterThan(-1);
    expect(commands.indexOf("page_write")).toBeLessThan(commands.indexOf("world_create"));
  });

  it("asks over the dialog about a page that cannot save, and Cancel keeps the dialog and the world", async () => {
    const calls = mockWorldIpc({
      page_write: () => {
        throw { kind: "io", message: "Another program is using the file." };
      },
    });
    await editThenStartNewWorld();

    create();
    const asked = await screen.findByRole("dialog", { name: '"Overview" could not be saved' });
    // Later in the document on the same layer, so it shows over the New world dialog.
    const newWorld = screen.getByRole("dialog", { name: "New world" });
    expect(newWorld.compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(asked).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /could not be saved/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog", { name: "New world" })).toBeInTheDocument();
    expect(nameInput()).toHaveValue("Saltmere");
    expect(commandsOf(calls)).not.toContain("world_create");
    expect(screen.getByRole("heading", { name: testWorld.name })).toBeInTheDocument();
  });
});
