import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkedPage, PageMatch, PageMatches, TextMatch, TextMatches } from "@/types/api";
import { QuickOpen, type QuickOpenProps } from "./QuickOpen";

type Handler = (args: Record<string, unknown>) => unknown;

/** No page's text matches. */
const noText = () => ({ state: "ready", pages: [] });

/**
 * Mocks the core with `given`, where no page's text matches unless `search_text` is given, and
 * returns the calls it receives, in order.
 */
function mockCore(given: Record<string, Handler>) {
  const handlers: Record<string, Handler> = { search_text: noText, ...given };
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC((command, args) => {
    const given = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, args: given });
    const handler = handlers[command];
    if (!handler) throw `unexpected command ${command}`;
    return handler(given);
  });
  return calls;
}

const page = (path: string): PageMatch => ({
  path,
  name: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  field: "name",
  alias: null,
  mark: { from: 0, to: 1 },
});

/** Stand-in ports, recording what they were asked in order. */
function ports(overrides: Partial<QuickOpenProps> = {}) {
  const asked: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      asked.push([name, ...args]);
  const props: QuickOpenProps = {
    session: 1,
    activePage: "Places/Saltmere.md",
    indexRevision: 0,
    openPage: record("openPage"),
    pageCreated: record("pageCreated"),
    refreshTree: record("refreshTree"),
    showWorldMissing: record("showWorldMissing"),
    close: record("close"),
    ...overrides,
  };
  return { props, asked };
}

function renderQuickOpen(props: QuickOpenProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <QuickOpen {...props} />
    </QueryClientProvider>,
  );
  return (next: Partial<QuickOpenProps>) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <QuickOpen {...props} {...next} />
      </QueryClientProvider>,
    );
}

const textMatch = (path: string, at: number): TextMatch => ({
  path,
  name: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  lines: [{ text: `line at ${at}`, at, marks: [{ from: 0, to: 4 }] }],
});

const input = () => screen.getByRole("combobox", { name: "Search pages" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const createRow = () => screen.queryByRole("option", { name: /^Create page/ });

describe("QuickOpen", () => {
  it("asks for each trimmed query, again when the index changes, and never for an empty one", async () => {
    const calls = mockCore({
      search_pages: ({ query }) => ({ state: "ready", pages: [page(`${String(query)}.md`)] }),
    });
    const rerender = renderQuickOpen(ports().props);

    type("   ");
    type("mir");
    expect(await screen.findByRole("option", { name: "mir" })).toBeInTheDocument();
    type(" mir ");
    rerender({ indexRevision: 1 });
    await waitFor(() => expect(calls).toHaveLength(4));

    expect(calls.filter((call) => call.command === "search_pages")).toEqual([
      { command: "search_pages", args: { query: "mir" } },
      { command: "search_pages", args: { query: "mir" } },
    ]);
    expect(calls.filter((call) => call.command === "search_text")).toEqual([
      { command: "search_text", args: { query: "mir" } },
      { command: "search_text", args: { query: "mir" } },
    ]);
    type("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("never shows an older query's answer once a newer query is typed", async () => {
    const answers: Record<string, (matches: PageMatches) => void> = {};
    mockCore({
      search_pages: ({ query }) =>
        new Promise((resolve) => {
          answers[String(query)] = resolve;
        }),
    });
    renderQuickOpen(ports().props);

    type("m");
    await waitFor(() => expect(answers.m).toBeDefined());
    type("mi");
    await waitFor(() => expect(answers.mi).toBeDefined());
    await act(async () => {
      answers.m({ state: "ready", pages: [page("Mountain.md")] });
      // Long enough for an answer that could show to show.
      await new Promise((settled) => setTimeout(settled, 50));
    });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    await act(async () => answers.mi({ state: "ready", pages: [page("Mirela.md")] }));
    const shown = await screen.findAllByRole("option");
    expect(shown.map((option) => option.textContent)).toEqual(["Mirela"]);
  });

  it("offers Create only for the current query's answer from a built index with no pages", async () => {
    let state: "ready" | "building" = "building";
    mockCore({ search_pages: () => ({ state, pages: [] }) });
    const rerender = renderQuickOpen(ports().props);

    type("Harbor");
    expect(await screen.findByText("Indexing world…")).toBeInTheDocument();
    expect(createRow()).not.toBeInTheDocument();

    state = "ready";
    rerender({ indexRevision: 1 });
    expect(await screen.findByRole("option", { name: 'Create page "Harbor"' })).toBeVisible();

    // While the next query's answer is on its way, the last answer shows without Create.
    type("Harbor office");
    expect(createRow()).not.toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: 'Create page "Harbor office"' }),
    ).toBeVisible();
  });

  it("closes, then opens a picked page in the current or a new tab", async () => {
    mockCore({ search_pages: () => ({ state: "ready", pages: [page("Mirela.md")] }) });
    const { props, asked } = ports();
    renderQuickOpen(props);

    type("mir");
    const row = await screen.findByRole("option", { name: "Mirela" });
    fireEvent.click(row);
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });

    expect(asked).toEqual([
      ["close"],
      ["openPage", "Mirela.md", { newTab: false }],
      ["close"],
      ["openPage", "Mirela.md", { newTab: true }],
    ]);
  });

  it("shows page matches before a delayed text answer, and the text groups once it comes", async () => {
    let answerText: (matches: TextMatches) => void = () => {};
    mockCore({
      search_pages: () => ({ state: "ready", pages: [page("Mirela.md")] }),
      search_text: () =>
        new Promise((resolve) => {
          answerText = resolve;
        }),
    });
    renderQuickOpen(ports().props);

    type("spared");
    expect(await screen.findByRole("option", { name: "Mirela" })).toBeVisible();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();

    await act(async () => answerText({ state: "ready", pages: [textMatch("Log/Arrival.md", 9)] }));
    expect(await screen.findByRole("group", { name: "Arrival, Log" })).toBeVisible();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Mirela",
      "line at 9",
    ]);
  });

  it("never shows an older query's text answer once a newer query's has come", async () => {
    const answers: Record<string, (matches: TextMatches) => void> = {};
    mockCore({
      search_pages: () => ({ state: "ready", pages: [] }),
      search_text: ({ query }) =>
        new Promise((resolve) => {
          answers[String(query)] = resolve;
        }),
    });
    renderQuickOpen(ports().props);

    type("sp");
    await waitFor(() => expect(answers.sp).toBeDefined());
    type("spa");
    await waitFor(() => expect(answers.spa).toBeDefined());
    await act(async () => answers.spa({ state: "ready", pages: [textMatch("New.md", 1)] }));
    await screen.findByRole("group", { name: "New" });
    await act(async () => {
      answers.sp({ state: "ready", pages: [textMatch("Old.md", 2)] });
      // Long enough for an answer that could show to show.
      await new Promise((settled) => setTimeout(settled, 50));
    });

    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual([
      "New",
    ]);
  });

  it("says that nothing matches only once both answers for the query are empty", async () => {
    let answerText: (matches: TextMatches) => void = () => {};
    mockCore({
      search_pages: () => ({ state: "ready", pages: [] }),
      search_text: () =>
        new Promise((resolve) => {
          answerText = resolve;
        }),
    });
    renderQuickOpen(ports().props);

    type("zzzz");
    expect(await screen.findByRole("option", { name: 'Create page "zzzz"' })).toBeVisible();
    expect(screen.queryByText('Nothing matches "zzzz".')).not.toBeInTheDocument();

    await act(async () => answerText({ state: "ready", pages: [] }));
    expect(await screen.findByText('Nothing matches "zzzz".')).toBeVisible();
  });

  it("keeps the page matches when the text request fails", async () => {
    mockCore({
      search_pages: () => ({ state: "ready", pages: [page("Mirela.md")] }),
      search_text: () => {
        throw { kind: "io", message: "The page index reported an error." };
      },
    });
    renderQuickOpen(ports().props);

    type("mir");

    expect(await screen.findByRole("option", { name: "Mirela" })).toBeVisible();
    await act(async () => {});
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText(/cannot be searched/)).not.toBeInTheDocument();
  });

  it("closes, then opens a picked line's page at its match, in the current or a new tab", async () => {
    mockCore({
      search_pages: () => ({ state: "ready", pages: [] }),
      search_text: () => ({ state: "ready", pages: [textMatch("Log/Arrival.md", 42)] }),
    });
    const { props, asked } = ports();
    renderQuickOpen(props);

    type("spared");
    const line = await screen.findByRole("option", { name: "line at 42" });
    fireEvent.click(line);
    fireEvent.click(line, { metaKey: true });

    expect(asked).toEqual([
      ["close"],
      ["openPage", "Log/Arrival.md", { newTab: false, at: 42 }],
      ["close"],
      ["openPage", "Log/Arrival.md", { newTab: true, at: 42 }],
    ]);
  });

  /** Types `query`, picks Create, and waits for the core's answer to be taken in. */
  async function create(outcome: () => LinkedPage, props: Partial<QuickOpenProps> = {}) {
    const calls = mockCore({
      search_pages: () => ({ state: "ready", pages: [] }),
      search_create: () => outcome(),
    });
    const { props: given, asked } = ports(props);
    renderQuickOpen(given);
    type("Harbor");
    fireEvent.click(await screen.findByRole("option", { name: 'Create page "Harbor"' }));
    await waitFor(() => expect(calls.at(-1)?.command).toBe("search_create"));
    return { calls, asked };
  }

  it("creates the page in the active page's folder and opens it as created", async () => {
    const { calls, asked } = await create(() => ({ state: "created", path: "Places/Harbor.md" }));

    expect(calls.at(-1)?.args).toEqual({ from: "Places/Saltmere.md", query: "Harbor" });
    await waitFor(() => expect(asked).toEqual([["close"], ["pageCreated", "Places/Harbor.md"]]));
  });

  it("opens a page that exists in another letter case in a new tab", async () => {
    const existing = await create(() => ({ state: "existing", path: "harbor.md" }), {
      activePage: null,
    });
    expect(existing.calls.at(-1)?.args).toEqual({ from: null, query: "Harbor" });
    await waitFor(() =>
      expect(existing.asked).toEqual([["close"], ["openPage", "harbor.md", { newTab: true }]]),
    );
  });

  it("does nothing when the index is not built by the time it creates", async () => {
    const { asked } = await create(() => ({ state: "not_ready" }));

    await act(async () => {});
    expect(asked).toEqual([]);
    expect(input()).toBeInTheDocument();
  });

  it("shows why the page was not created, lists the tree again, and clears the reason on typing", async () => {
    const refusals = [
      [
        { kind: "invalid_name", message: "Names cannot end with a dot." },
        "Names cannot end with a dot.",
      ],
      [
        { kind: "exists", message: "Something with this name already exists here." },
        "Something with this name already exists here.",
      ],
      [
        { kind: "invalid_path", message: "The link does not point…" },
        "The page cannot be created there.",
      ],
      [
        { kind: "io", message: "The disk is full." },
        "The page could not be created: The disk is full.",
      ],
    ] as const;
    for (const [refusal, shown] of refusals) {
      const { asked } = await create(() => {
        throw refusal;
      });

      expect(await screen.findByText(shown)).toBeInTheDocument();
      expect(input()).toHaveAccessibleDescription(shown);
      expect(asked).toEqual([["refreshTree"]]);
      type("Harbor 2");
      expect(screen.queryByText(shown)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("closes and shows the missing-world notice when the world's folder is gone", async () => {
    const { asked } = await create(() => {
      throw { kind: "world_missing", message: "The world's folder cannot be found." };
    });

    await waitFor(() => expect(asked).toEqual([["refreshTree"], ["close"], ["showWorldMissing"]]));
  });
});
