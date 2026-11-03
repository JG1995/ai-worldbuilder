import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  Accepted,
  AnswerEnd,
  AnswerEvent,
  AnswerReview,
  ContextPage,
  Conversation,
  Conversations,
  EditorLinks,
  ProposalReview,
} from "@/types/api";
import { answerChannel, mockAssistantIpc } from "../api/test-ipc";
import { Assistant, type AssistantPorts } from "./Assistant";

type PendingSend = {
  args: Record<string, unknown>;
  send: (event: AnswerEvent) => void;
  end: (end: AnswerEnd) => void;
};

type Handler = (args: Record<string, unknown>) => unknown;

/** The world's conversations as the core reads them: none, saved as usual, unless overridden. */
const emptyStore: Record<string, Handler> = {
  assistant_conversations: () => ({ items: [], notice: null }),
  assistant_review: () => [],
  assistant_conversation: () => {
    throw { kind: "not_found", message: "The conversation does not exist." };
  },
};

/**
 * Mocks the core with sends that wait for the test to stream and end them, with the links of an
 * answer's text from `links`, none by default, and with an empty conversation store unless
 * `overrides` replace its commands.
 */
function mockPendingSends(
  links: (text: string) => EditorLinks = () => ({ state: "ready", links: [] }),
  overrides: Record<string, Handler> = {},
) {
  const sends: PendingSend[] = [];
  const calls = mockAssistantIpc({
    ...emptyStore,
    assistant_send: (args) =>
      new Promise((resolve) => sends.push({ args, send: answerChannel(args), end: resolve })),
    assistant_links: (args) => links(args.text as string),
    ...overrides,
  });
  /** The calls that sent a message, in order. */
  const sent = () => calls.filter(({ command }) => command === "assistant_send");
  /** The commands called, in order, without the reads of the conversations, links and proposals. */
  const commands = () =>
    calls
      .map(({ command }) => command)
      .filter(
        (command) =>
          !["assistant_conversations", "assistant_links", "assistant_review"].includes(command),
      );
  return { calls, sends, sent, commands };
}

function renderAssistant(ports: Partial<AssistantPorts> = {}, conversation: number | null = null) {
  const all: AssistantPorts = {
    session: 1,
    activePage: "Places/Kesh Tor.md",
    indexRevision: 0,
    openPage: vi.fn(),
    flushActive: vi.fn(() => Promise.resolve()),
    hasPage: () => true,
    flushPages: vi.fn(() => Promise.resolve(true)),
    pagesWritten: vi.fn(() => Promise.resolve()),
    pagesDeleted: vi.fn(() => Promise.resolve()),
    showToast: vi.fn(),
    setReviewPaths: vi.fn(),
    ...ports,
  };
  const onConversationChange = vi.fn();
  const element = (ports: AssistantPorts) => (
    <Assistant
      ports={ports}
      conversation={conversation}
      onConversationChange={onConversationChange}
      model="mistral-small"
      host="api.example.com"
      onOpenSettings={() => {}}
    />
  );
  const { rerender, unmount } = render(element(all));
  /** Renders the assistant again as after the world's index changed. */
  const indexChanged = () => rerender(element({ ...all, indexRevision: all.indexRevision + 1 }));
  return { ...all, indexChanged, onConversationChange, unmount };
}

const composer = () => screen.getByRole("textbox", { name: "Message" });

function sendMessage(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter" });
}

const answers = () => screen.queryAllByRole("textbox", { name: "Answer" });
const announced = (text: string) => expect(screen.getByText(text)).toHaveAttribute("aria-live");
/** The pane's polite live region; each answer's editor has one of its own. */
const liveRegion = () => document.querySelector(".sr-only[aria-live]");

const keshTor: ContextPage = { path: "Places/Kesh Tor.md", partial: false };

/** Sends a message and lets the core start answering it, with `pages` as the context. */
async function startAnswer(sends: PendingSend[], text: string, pages: ContextPage[] = [keshTor]) {
  sendMessage(text);
  await waitFor(() => expect(sends).toHaveLength(1));
  const pending = sends[0];
  act(() => pending.send({ kind: "context", conversation: 7, pages, leftOut: 0, indexing: false }));
  return pending;
}

describe("sending a message", () => {
  it("shows the message at once and sends it with the active page only after its edits saved", async () => {
    const { sends, sent } = mockPendingSends();
    let saved = () => {};
    renderAssistant({ flushActive: () => new Promise((resolve) => (saved = resolve)) });

    sendMessage("Who lives at Kesh Tor?");

    expect(screen.getByText("Who lives at Kesh Tor?")).toBeInTheDocument();
    expect(composer()).toHaveValue("");
    await act(() => Promise.resolve());
    expect(sent()).toEqual([]);
    await act(async () => saved());
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sent()).toEqual([
      {
        command: "assistant_send",
        args: {
          conversation: null,
          text: "Who lives at Kesh Tor?",
          active: "Places/Kesh Tor.md",
          retry: false,
        },
      },
    ]);
  });

  it("streams the answer, with Stop in place of Send, and keeps the text the end carries", async () => {
    const { sends } = mockPendingSends();
    renderAssistant();

    const pending = await startAnswer(sends, "Who lives at Kesh Tor?");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    act(() => pending.send({ kind: "text", delta: "Brother " }));
    expect(answers()[0]).toHaveTextContent("Brother");
    act(() => pending.send({ kind: "text", delta: "Ketil." }));
    expect(answers()[0]).toHaveTextContent("Brother Ketil.");
    await act(async () =>
      pending.end({
        state: "complete",
        conversation: 7,
        text: "Brother Ketil, the monk.",
        answer: 11,
      }),
    );

    expect(answers()[0]).toHaveTextContent("Brother Ketil, the monk.");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    announced("The answer is complete.");
  });

  it("continues the conversation the core named", async () => {
    const { sends, sent } = mockPendingSends();
    renderAssistant();
    const pending = await startAnswer(sends, "Who lives at Kesh Tor?");
    await act(async () =>
      pending.end({ state: "complete", conversation: 7, text: "A monk.", answer: 11 }),
    );

    sendMessage("And who else?");

    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sent()[1].args).toMatchObject({ conversation: 7, text: "And who else?", retry: false });
  });

  it("calls Stop on Stop, and marks the answer the core stopped", async () => {
    const { calls, sends } = mockPendingSends();
    renderAssistant();
    const pending = await startAnswer(sends, "Who lives at Kesh Tor?");
    act(() => pending.send({ kind: "text", delta: "Brother" }));

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.map(({ command }) => command)).toContain("assistant_stop"));
    await act(async () =>
      pending.end({ state: "stopped", conversation: 7, text: "Brother", answer: 11 }),
    );

    expect(answers()[0]).toHaveTextContent("Brother");
    expect(screen.getByText("Stopped.")).toBeInTheDocument();
    announced("The answer was stopped.");
  });

  it("puts a refused message back into the composer with the core's reason", async () => {
    mockAssistantIpc({
      ...emptyStore,
      assistant_send: () => {
        throw { kind: "not_found", message: "No provider is saved." };
      },
    });
    renderAssistant();

    sendMessage("Who lives at Kesh Tor?");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The message could not be sent: No provider is saved.",
    );
    expect(composer()).toHaveValue("Who lives at Kesh Tor?");
    expect(screen.queryByText("Who lives at Kesh Tor?", { selector: "li" })).toBeNull();
  });
});

describe("the context disclosure", () => {
  it("lists the pages read and opens one, in a new tab with Ctrl", async () => {
    const { sends } = mockPendingSends();
    const ports = renderAssistant({ hasPage: (path) => path !== "Gone.md" });
    await startAnswer(sends, "Tell me about the tor", [
      keshTor,
      { path: "Overview.md", partial: true },
      { path: "Gone.md", partial: false },
    ]);

    const row = screen.getByRole("button", { name: "Read 3 pages" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Kesh Tor" }));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }), { ctrlKey: true });
    expect(ports.openPage).toHaveBeenNthCalledWith(1, "Places/Kesh Tor.md", { newTab: false });
    expect(ports.openPage).toHaveBeenNthCalledWith(2, "Overview.md", { newTab: true });
    const overview = screen.getByRole("button", { name: "Overview" }).closest("li");
    expect(overview).toHaveTextContent("(partly read)");
    // A page the world no longer has shows its name without a link.
    expect(screen.getByText("Gone")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gone" })).toBeNull();
  });

  it("says when no pages were read, how many earlier messages were left out, and that the world was being indexed", async () => {
    const { sends } = mockPendingSends();
    renderAssistant();
    sendMessage("Hello");
    await waitFor(() => expect(sends).toHaveLength(1));
    act(() =>
      sends[0].send({ kind: "context", conversation: 7, pages: [], leftOut: 3, indexing: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Read 0 pages" }));

    expect(screen.getByText("No pages were read.")).toBeVisible();
    expect(screen.getByText("3 earlier messages were left out.")).toBeVisible();
    expect(
      screen.getByText("The world was still being indexed, so some pages may be missing."),
    ).toBeVisible();
  });
});

describe("failures", () => {
  it("retries a first message whose key could not be read in the conversation the core named", async () => {
    const { sends, sent } = mockPendingSends();
    renderAssistant();
    sendMessage("Who lives at Kesh Tor?");
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () =>
      sends[0].end({
        state: "failed",
        conversation: 7,
        text: "",
        answer: null,
        reason: "key_unreadable",
        detail: "The keychain is locked.",
        providerMessage: null,
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The key cannot be read from its storage: The keychain is locked. Nothing was sent.",
    );
    expect(answers()).toHaveLength(1);
    announced("The answer failed.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sent()[1].args).toEqual({
      conversation: 7,
      text: "",
      active: "Places/Kesh Tor.md",
      retry: true,
    });
    // The new answer replaces the failed one.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(answers()).toHaveLength(1);
  });

  it("offers Retry only on the last message", async () => {
    const { sends } = mockPendingSends();
    renderAssistant();
    const failure = {
      state: "failed",
      conversation: 7,
      text: "",
      answer: null,
      reason: "interrupted",
      detail: null,
      providerMessage: null,
    } as const;
    sendMessage("First");
    await waitFor(() => expect(sends).toHaveLength(1));
    await act(async () => sends[0].end(failure));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    sendMessage("Second");
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => sends[1].end(failure));

    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getAllByRole("alert")[1]).toContainElement(
      screen.getByRole("button", { name: "Retry" }),
    );
  });

  it.each([
    ["rate_limited", "The provider is limiting requests. Try again later."],
    ["key_refused", "The provider refused the API key."],
    ["unreachable", "api.example.com could not be reached: Connection refused."],
    ["timeout", "api.example.com sent nothing for 120 seconds."],
    ["redirected", "The provider redirected the request to Connection refused"],
    ["invalid_reply", "The answer is not an OpenAI-compatible chat answer"],
    ["interrupted", "The connection ended before the answer was complete."],
  ] as const)("explains %s, with the provider's message as plain text", async (reason, wording) => {
    const { sends } = mockPendingSends();
    renderAssistant();
    const pending = await startAnswer(sends, "Who lives at Kesh Tor?");
    act(() => pending.send({ kind: "text", delta: "Brother" }));
    await act(async () =>
      pending.end({
        state: "failed",
        conversation: 7,
        text: "Brother",
        answer: 11,
        reason,
        detail: "Connection refused",
        providerMessage: "<b>Slow down</b>",
      }),
    );

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(wording);
    expect(within(notice).getByText("The provider's message: <b>Slow down</b>")).toBeVisible();
    expect(notice.querySelector("b")).toBeNull();
    // The warning line for rate limiting, the error line otherwise.
    expect(notice).toHaveClass(reason === "rate_limited" ? "border-warning" : "border-error");
    // The text that arrived stays.
    expect(answers()[0]).toHaveTextContent("Brother");
  });
});

describe("answers as references into the world", () => {
  const text = "See [[Kesh Tor#Shrine]] and [[Nowhere]].";

  /** The core's links of `text`: Kesh Tor resolves, Nowhere does not. */
  const keshTorLinks = (): EditorLinks => ({
    state: "ready",
    links: [
      {
        from: 4,
        to: 23,
        state: "resolved",
        target: "Kesh Tor",
        path: "Places/Kesh Tor.md",
        heading: "Shrine",
        block: null,
      },
      {
        from: 28,
        to: 39,
        state: "unresolved",
        target: "Nowhere",
        path: null,
        heading: null,
        block: null,
      },
    ],
  });

  /** Puts the cursor in the link written as `written` in `answer`, and presses Alt+Enter. */
  function follow(answer: HTMLElement, written: string) {
    const view = EditorView.findFromDOM(answer);
    if (!view) throw new Error("No editor");
    const at = view.state.doc.toString().indexOf(written) + 2;
    act(() => view.dispatch({ selection: { anchor: at } }));
    fireEvent.keyDown(answer, { key: "Enter", altKey: true });
  }

  /** Sends a message whose answer ends with `text`, and returns the answer's editor. */
  async function answered(sends: PendingSend[]) {
    const pending = await startAnswer(sends, "Where is the shrine?");
    await act(async () => pending.end({ state: "complete", conversation: 7, text, answer: 11 }));
    return answers()[0];
  }

  it("marks an answer's links once it ends, and follows only a resolved one, in a new tab", async () => {
    const { calls, sends } = mockPendingSends(keshTorLinks);
    const ports = renderAssistant();

    const answer = await answered(sends);

    await waitFor(() =>
      expect(answer.querySelector(".cm-link")).toHaveTextContent("[[Kesh Tor#Shrine]]"),
    );
    expect(answer.querySelector(".cm-link-unresolved")).toHaveTextContent("[[Nowhere]]");
    expect(calls.filter(({ command }) => command === "assistant_links")).toEqual([
      { command: "assistant_links", args: { text } },
    ]);
    follow(answer, "[[Kesh Tor");
    expect(ports.openPage).toHaveBeenCalledExactlyOnceWith("Places/Kesh Tor.md", {
      newTab: true,
      at: { heading: "Shrine", block: null },
    });
    follow(answer, "[[Nowhere");
    expect(ports.openPage).toHaveBeenCalledOnce();
    // Nothing is created: the core is asked only to send, and for links, conversations and proposals.
    expect(new Set(calls.map(({ command }) => command))).toEqual(
      new Set(["assistant_conversations", "assistant_send", "assistant_links", "assistant_review"]),
    );
  });

  it("marks an answer that ended while the index was built once the index changes", async () => {
    let built = false;
    const { calls, sends } = mockPendingSends(() =>
      built ? keshTorLinks() : { state: "not_ready" },
    );
    const ports = renderAssistant();
    const answer = await answered(sends);
    const asked = () => calls.filter(({ command }) => command === "assistant_links");
    await waitFor(() => expect(asked()).toHaveLength(1));
    expect(answer.querySelector(".cm-link")).toBeNull();

    built = true;
    ports.indexChanged();

    await waitFor(() =>
      expect(answer.querySelector(".cm-link")).toHaveTextContent("[[Kesh Tor#Shrine]]"),
    );
    expect(asked()).toHaveLength(2);
  });

  it("copies an answer's text once it has ended, and says whether it could", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { sends } = mockPendingSends();
    renderAssistant();
    const pending = await startAnswer(sends, "Where is the shrine?");
    act(() => pending.send({ kind: "text", delta: "See" }));
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    await act(async () => pending.end({ state: "complete", conversation: 7, text, answer: 11 }));

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(text));
    await waitFor(() => announced("Copied"));
    writeText.mockImplementation(() => Promise.reject(new Error("Denied")));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => announced("The answer could not be copied."));
    vi.unstubAllGlobals();
  });
});

describe("saved conversations", () => {
  const saltmere: Conversation = {
    id: 3,
    title: "Where is Saltmere?",
    messages: [
      { role: "user", text: "Where is Saltmere?", time: 100 },
      {
        role: "answer",
        id: 12,
        text: "See [[Kesh Tor#Shrine]].",
        time: 101,
        state: "complete",
        pages: [keshTor],
        leftOut: 0,
        indexing: false,
      },
    ],
  };
  const listed: Conversations = {
    items: [
      { id: 5, title: "The glass storm", updated: 1_700_000_200 },
      { id: 3, title: "Where is Saltmere?", updated: 1_700_000_100 },
    ],
    notice: null,
  };
  const storm: Conversation = {
    id: 5,
    title: "The glass storm",
    messages: [{ role: "user", text: "The glass storm", time: 200 }],
  };
  const byId = (args: Record<string, unknown>) => {
    const found = [saltmere, storm].find(({ id }) => id === args.id);
    if (!found) throw { kind: "not_found", message: "The conversation does not exist." };
    return found;
  };

  it("shows the conversation shown last, with its answer's links marked and followed", async () => {
    const { calls } = mockPendingSends(
      () => ({
        state: "ready",
        links: [
          {
            from: 4,
            to: 23,
            state: "resolved",
            target: "Kesh Tor",
            path: "Places/Kesh Tor.md",
            heading: "Shrine",
            block: null,
          },
        ],
      }),
      { assistant_conversation: byId },
    );
    const ports = renderAssistant({}, 3);

    expect(await screen.findByText("Where is Saltmere?")).toBeInTheDocument();
    // The answer's editor can mount just after the question shows.
    const [answer] = await screen.findAllByRole("textbox", { name: "Answer" });
    await waitFor(() =>
      expect(answer.querySelector(".cm-link")).toHaveTextContent("[[Kesh Tor#Shrine]]"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Read 1 page" }));
    expect(screen.getByRole("button", { name: "Kesh Tor" })).toBeInTheDocument();
    const view = EditorView.findFromDOM(answer);
    act(() => view?.dispatch({ selection: { anchor: 8 } }));
    fireEvent.keyDown(answer, { key: "Enter", altKey: true });
    expect(ports.openPage).toHaveBeenCalledWith("Places/Kesh Tor.md", {
      newTab: true,
      at: { heading: "Shrine", block: null },
    });
    expect(calls.find(({ command }) => command === "assistant_conversation")?.args).toEqual({
      id: 3,
    });
    expect(ports.onConversationChange).toHaveBeenLastCalledWith(3);
  });

  it("says it is loading, and shows a conversation that cannot be read as an empty one with the reason", async () => {
    let fail = (_error: unknown) => {};
    mockPendingSends(undefined, {
      assistant_conversation: () => new Promise((_resolve, reject) => (fail = reject)),
    });
    const ports = renderAssistant({}, 3);

    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    await act(async () => fail({ kind: "io", message: "The disk is busy." }));

    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The conversation could not be loaded: The disk is busy.",
    );
    expect(screen.getByText(/written only when you accept them\./)).toBeVisible();
    // The world keeps remembering it, for an opening that can read it.
    expect(ports.onConversationChange).not.toHaveBeenCalled();
  });

  it("shows a conversation that is gone as a new one", async () => {
    mockPendingSends();
    const ports = renderAssistant({}, 3);

    await waitFor(() => expect(ports.onConversationChange).toHaveBeenCalledWith(null));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/written only when you accept them\./)).toBeVisible();
  });

  it("stops a running answer before starting a new conversation or opening another", async () => {
    const { sends, commands } = mockPendingSends(undefined, {
      assistant_conversations: () => listed,
      assistant_conversation: byId,
      // Ends the running answer as the core does, before it resolves.
      assistant_stop: () => {
        sends.at(-1)?.end({ state: "stopped", conversation: 7, text: "", answer: 11 });
        return null;
      },
    });
    const ports = renderAssistant();
    await startAnswer(sends, "Who lives at Kesh Tor?");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => expect(answers()).toHaveLength(0));
    expect(commands()).toEqual(["assistant_send", "assistant_stop"]);
    expect(ports.onConversationChange).toHaveBeenLastCalledWith(null);

    sendMessage("And the storm?");
    await waitFor(() => expect(sends).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Where is Saltmere\?/ }));

    expect(await screen.findByText("See [[Kesh Tor#Shrine]].")).toBeInTheDocument();
    expect(commands()).toEqual([
      "assistant_send",
      "assistant_stop",
      "assistant_send",
      "assistant_stop",
      "assistant_conversation",
    ]);
    expect(screen.queryByText("And the storm?")).toBeNull();
    expect(ports.onConversationChange).toHaveBeenLastCalledWith(3);
  });

  it("lists the conversations in the core's order, and Back returns to the one shown", async () => {
    mockPendingSends(undefined, { assistant_conversations: () => listed });
    renderAssistant();

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));

    const list = await screen.findByRole("region", { name: "Conversations" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".ui-strong")?.textContent)).toEqual([
      "The glass storm",
      "Where is Saltmere?",
    ]);
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("region", { name: "Conversations" })).toBeNull();
    expect(composer()).toHaveFocus();
  });

  it("says when there are no conversations yet", async () => {
    mockPendingSends();
    renderAssistant();

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));

    expect(
      await screen.findByText("There are no conversations in this world yet."),
    ).toBeInTheDocument();
  });

  it("deletes a conversation after a confirmation with Cancel focused, and shows an empty one in place of it", async () => {
    let items = listed.items;
    const { calls } = mockPendingSends(undefined, {
      assistant_conversations: () => ({ items, notice: null }),
      assistant_conversation: byId,
      assistant_delete: (args) => {
        items = items.filter(({ id }) => id !== args.id);
        return null;
      },
    });
    const ports = renderAssistant({}, 3);
    expect(await screen.findByText("See [[Kesh Tor#Shrine]].")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    const list = await screen.findByRole("region", { name: "Conversations" });
    const row = () => within(list).getByText("Where is Saltmere?").closest("li") as HTMLElement;

    fireEvent.click(within(row()).getByRole("button", { name: "Delete conversation" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "Where is Saltmere?"?' });
    expect(dialog).toHaveTextContent("cannot be undone");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some(({ command }) => command === "assistant_delete")).toBe(false);

    fireEvent.click(within(row()).getByRole("button", { name: "Delete conversation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete conversation" }),
    );

    await waitFor(() => expect(within(list).queryByText("Where is Saltmere?")).toBeNull());
    expect(calls.find(({ command }) => command === "assistant_delete")?.args).toEqual({ id: 3 });
    expect(within(list).getByRole("button", { name: "Back" })).toHaveFocus();
    expect(ports.onConversationChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(within(list).getByRole("button", { name: "Back" }));
    expect(answers()).toHaveLength(0);
    expect(screen.getByText(/written only when you accept them\./)).toBeVisible();
  });

  it("says no answer arrived for a message, with Retry only on the last one", async () => {
    const crashed: Conversation = {
      id: 4,
      title: "First",
      messages: [
        { role: "user", text: "First", time: 1 },
        { role: "user", text: "Second", time: 2 },
      ],
    };
    const { sends, sent } = mockPendingSends(undefined, {
      assistant_conversation: () => crashed,
    });
    renderAssistant({}, 4);

    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getAllByText("No answer arrived for this message.")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sent()[0].args).toEqual({
      conversation: 4,
      text: "",
      active: "Places/Kesh Tor.md",
      retry: true,
    });
    expect(screen.getAllByText("No answer arrived for this message.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("shows that earlier conversations were set aside, and that they are not saved once an answer ends unsaved", async () => {
    let notice: Conversations["notice"] = { kind: "set_aside" };
    const { sends } = mockPendingSends(undefined, {
      assistant_conversations: () => ({ items: [], notice }),
    });
    renderAssistant();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This world's earlier conversations could not be read and were set aside.",
    );
    const pending = await startAnswer(sends, "Who lives at Kesh Tor?");
    notice = { kind: "not_saved", reason: "The conversation store cannot be written." };
    await act(async () =>
      pending.end({ state: "complete", conversation: 7, text: "A monk.", answer: 11 }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This world's conversations are not being saved: The conversation store cannot be written. Messages from now on are lost when the world closes.",
      ),
    );
    expect(screen.getByRole("alert")).toHaveClass("border-warning");
  });
});

describe("proposals", () => {
  const conversation: Conversation = {
    id: 3,
    title: "Mark Mirela as captured",
    messages: [
      { role: "user", text: "Mark Mirela as captured", time: 100 },
      {
        role: "answer",
        id: 11,
        text: "Here are the changes.",
        time: 101,
        state: "complete",
        pages: [],
        leftOut: 0,
        indexing: false,
      },
    ],
  };
  // The model named the page `saltmere`; the core found it on disk as `Saltmere.md`.
  const saltmere: ProposalReview = {
    id: 1,
    kind: "edit",
    path: "saltmere",
    page: "Saltmere.md",
    state: "pending",
    undone: false,
    accept: null,
    check: {
      state: "applies",
      lines: [
        { kind: "removed", text: "Mirela is free." },
        { kind: "added", text: "Mirela is captured." },
      ],
      version: "v1",
      changed: false,
    },
  };
  const keshTor: ProposalReview = {
    id: 2,
    kind: "new_page",
    path: "Places/Kesh Tor.md",
    page: null,
    state: "pending",
    undone: false,
    accept: null,
    check: {
      state: "applies",
      lines: [{ kind: "added", text: "# Kesh Tor" }],
      version: null,
      changed: false,
    },
  };
  const reviewOf = (
    proposals: ProposalReview[],
    accepted: AnswerReview["accepted"] = [],
  ): AnswerReview[] => [{ answer: 11, unreadable: 0, unfinished: false, proposals, accepted }];
  const acceptedAs = (proposal: ProposalReview, page: string): ProposalReview => ({
    ...proposal,
    page,
    state: "accepted",
    accept: 5,
    check: null,
  });
  const written = [
    { path: "Places/Kesh Tor.md", text: "# Kesh Tor\n", version: "k1" },
    { path: "Saltmere.md", text: "Mirela is captured.\n", version: "v2" },
  ];

  /**
   * Mocks the core with the conversation above, whose proposals `review` reads, and `overrides`.
   * Returns the calls and how often the proposals were read.
   */
  function mockCore(review: () => AnswerReview[], overrides: Record<string, Handler> = {}) {
    const { calls } = mockPendingSends(undefined, {
      assistant_conversation: () => conversation,
      assistant_review: () => review(),
      ...overrides,
    });
    const reads = () => calls.filter(({ command }) => command === "assistant_review").length;
    const argsOf = (command: string) => calls.find((call) => call.command === command)?.args;
    return { calls, reads, argsOf };
  }

  const card = (name: string) => screen.findByRole("article", { name });

  it("names each proposal begun while the answer streams, until it ends", async () => {
    const { sends } = mockPendingSends();
    renderAssistant();
    const pending = await startAnswer(sends, "Flesh out Saltmere");

    act(() => pending.send({ kind: "proposal", change: "new_page", path: "Places/Docks" }));
    act(() => pending.send({ kind: "proposal", change: "edit", path: "saltmere" }));

    expect(screen.getByText("Proposing a new page: Places/Docks")).toBeInTheDocument();
    expect(screen.getByText("Proposing an edit: saltmere")).toBeInTheDocument();
    await act(async () =>
      pending.end({ state: "complete", conversation: 7, text: "Done.", answer: 11 }),
    );
    expect(screen.queryByText("Proposing an edit: saltmere")).toBeNull();
  });

  it("reads the proposals once the answer ends, and again when the index changes", async () => {
    let reviews: AnswerReview[] = [];
    const { sends, calls } = mockPendingSends(undefined, { assistant_review: () => reviews });
    const ports = renderAssistant();
    const pending = await startAnswer(sends, "Mark Mirela as captured");
    reviews = reviewOf([saltmere]);

    await act(async () =>
      pending.end({ state: "complete", conversation: 7, text: "Done.", answer: 11 }),
    );

    expect(await card("Edit: Saltmere")).toBeInTheDocument();
    const reads = () => calls.filter(({ command }) => command === "assistant_review");
    expect(reads().at(-1)?.args).toEqual({ conversation: 7 });
    const before = reads().length;
    ports.indexChanged();
    await waitFor(() => expect(reads()).toHaveLength(before + 1));
  });

  it("marks the tab of a pending edit's page on disk, saves that page before accepting, and clears the mark on unmount", async () => {
    const gone: ProposalReview = {
      ...saltmere,
      id: 3,
      page: "Gone.md",
      check: { state: "no_longer_applies", reason: "A passage is missing from the page." },
    };
    mockCore(() => reviewOf([saltmere, keshTor, gone]));
    const ports = renderAssistant({}, 3);

    await card("Edit: Saltmere");
    await waitFor(() => expect(ports.setReviewPaths).toHaveBeenLastCalledWith(["Saltmere.md"]));
    fireEvent.click(within(await card("Edit: Saltmere")).getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(ports.flushPages).toHaveBeenCalledExactlyOnceWith(["Saltmere.md"]));
    ports.unmount();
    expect(ports.setReviewPaths).toHaveBeenLastCalledWith([]);
  });

  it("rejects a proposal, and a rejected edit's title still opens its page while a new page's title is plain text", async () => {
    let reviews = reviewOf([saltmere, keshTor]);
    const { argsOf } = mockCore(() => reviews, {
      assistant_reject: () => {
        reviews = reviewOf([{ ...saltmere, state: "rejected", check: null }, keshTor]);
        return null;
      },
    });
    const ports = renderAssistant({}, 3);

    fireEvent.click(within(await card("Edit: Saltmere")).getByRole("button", { name: "Reject" }));

    await waitFor(async () => expect(await card("Edit: Saltmere")).toHaveTextContent("Rejected"));
    expect(argsOf("assistant_reject")).toEqual({ proposal: 1 });
    fireEvent.click(within(await card("Edit: Saltmere")).getByRole("button", { name: "Saltmere" }));
    expect(ports.openPage).toHaveBeenCalledExactlyOnceWith("Saltmere.md", { newTab: false });
    expect(
      within(await card("New page: Kesh Tor")).queryByRole("button", { name: "Kesh Tor" }),
    ).toBeNull();
  });

  it("saves the pages first, sends the versions the cards showed, takes in the written pages and shows the toast, whose Undo undoes the set", async () => {
    const order: string[] = [];
    let reviews = reviewOf([keshTor, saltmere]);
    const accepted: Accepted = { set: 5, accepted: 2, of: 2, written, failure: null, undo: true };
    const { argsOf } = mockCore(() => reviews, {
      assistant_accept: () => {
        order.push("accept");
        reviews = reviewOf(
          [acceptedAs(keshTor, "Places/Kesh Tor.md"), acceptedAs(saltmere, "Saltmere.md")],
          [{ id: 5, count: 2, undo: true }],
        );
        return accepted;
      },
      assistant_undo: () => ({ restored: [], deleted: [] }),
    });
    const ports = renderAssistant(
      {
        flushPages: vi.fn(async () => {
          order.push("save");
          return true;
        }),
      },
      3,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept selected" }));

    await waitFor(() => expect(ports.showToast).toHaveBeenCalledOnce());
    expect(order).toEqual(["save", "accept"]);
    expect(ports.flushPages).toHaveBeenCalledWith(["Saltmere.md"]);
    expect(argsOf("assistant_accept")).toEqual({
      answer: 11,
      proposals: [
        { id: 2, version: null },
        { id: 1, version: "v1" },
      ],
    });
    expect(ports.pagesWritten).toHaveBeenCalledExactlyOnceWith(written, { flash: true });
    const [message, action] = vi.mocked(ports.showToast).mock.calls[0];
    expect(message).toBe("Accepted 2 changes");
    expect(liveRegion()).toHaveTextContent("Accepted 2 changes");
    expect(await card("Edit: Saltmere")).toHaveTextContent("Accepted");

    act(() => action?.run());
    await waitFor(() => expect(argsOf("assistant_undo")).toEqual({ set: 5 }));
    expect(ports.flushPages).toHaveBeenLastCalledWith(["Places/Kesh Tor.md", "Saltmere.md"]);
  });

  it("reads the proposals again when the core refuses the accept with a conflict, without a toast", async () => {
    let reviews = reviewOf([saltmere]);
    const message = "The page changed since the proposal was reviewed.";
    const { reads } = mockCore(() => reviews, {
      assistant_accept: () => {
        reviews = reviewOf([
          {
            ...saltmere,
            check: { ...saltmere.check, version: "v2", changed: true } as ProposalReview["check"],
          },
        ]);
        throw { kind: "conflict", message };
      },
    });
    const ports = renderAssistant({}, 3);
    fireEvent.click(within(await card("Edit: Saltmere")).getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(
        screen.getByText("This page changed since the proposal was made."),
      ).toBeInTheDocument(),
    );
    expect(reads()).toBeGreaterThanOrEqual(2);
    expect(ports.showToast).not.toHaveBeenCalled();
    expect(liveRegion()).toHaveTextContent(message);
  });

  it("shows a partial accept as N of M changes, with the reason on the failed card", async () => {
    let reviews = reviewOf([keshTor, saltmere]);
    mockCore(() => reviews, {
      assistant_accept: () => {
        reviews = reviewOf(
          [acceptedAs(keshTor, "Places/Kesh Tor.md"), saltmere],
          [{ id: 5, count: 1, undo: true }],
        );
        return {
          set: 5,
          accepted: 1,
          of: 2,
          written: written.slice(0, 1),
          failure: { proposal: 1, message: "The page is read-only." },
          undo: true,
        } satisfies Accepted;
      },
    });
    const ports = renderAssistant({}, 3);

    fireEvent.click(await screen.findByRole("button", { name: "Accept selected" }));

    await waitFor(() =>
      expect(ports.showToast).toHaveBeenCalledWith(
        "Accepted 1 of 2 changes",
        expect.objectContaining({ label: "Undo" }),
      ),
    );
    expect(await card("Edit: Saltmere")).toHaveTextContent(
      "This change could not be written: The page is read-only.",
    );
  });

  it("shows no toast when nothing was written, and the reason on the card", async () => {
    mockCore(() => reviewOf([saltmere]), {
      assistant_accept: () =>
        ({
          set: null,
          accepted: 0,
          of: 1,
          written: [],
          failure: { proposal: 1, message: "The page is read-only." },
          undo: false,
        }) satisfies Accepted,
    });
    const ports = renderAssistant({}, 3);

    fireEvent.click(within(await card("Edit: Saltmere")).getByRole("button", { name: "Accept" }));

    await waitFor(async () =>
      expect(await card("Edit: Saltmere")).toHaveTextContent("The page is read-only."),
    );
    expect(ports.showToast).not.toHaveBeenCalled();
    expect(liveRegion()).toHaveTextContent("The page is read-only.");
  });

  it("offers no Undo, in the toast or the pane, for an accept history did not record", async () => {
    let reviews = reviewOf([saltmere]);
    mockCore(() => reviews, {
      assistant_accept: () => {
        reviews = reviewOf(
          [acceptedAs(saltmere, "Saltmere.md")],
          [{ id: 5, count: 1, undo: false }],
        );
        return {
          set: 5,
          accepted: 1,
          of: 1,
          written: written.slice(1),
          failure: null,
          undo: false,
        } satisfies Accepted;
      },
    });
    const ports = renderAssistant({}, 3);

    fireEvent.click(within(await card("Edit: Saltmere")).getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(ports.showToast).toHaveBeenCalledExactlyOnceWith("Accepted 1 change", undefined),
    );
    await waitFor(async () => expect(await card("Edit: Saltmere")).toHaveTextContent("Accepted"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows an accept that fails as a toast, and sends nothing when a page could not be saved", async () => {
    const { argsOf } = mockCore(() => reviewOf([saltmere]), {
      assistant_accept: () => {
        throw { kind: "io", message: "The conversation store cannot be written." };
      },
    });
    const ports = renderAssistant({ flushPages: vi.fn(() => Promise.resolve(false)) }, 3);
    const accept = within(await card("Edit: Saltmere")).getByRole("button", { name: "Accept" });

    fireEvent.click(accept);
    await waitFor(() => expect(ports.flushPages).toHaveBeenCalledOnce());
    await act(() => Promise.resolve());
    expect(argsOf("assistant_accept")).toBeUndefined();

    vi.mocked(ports.flushPages).mockResolvedValue(true);
    fireEvent.click(accept);
    await waitFor(() =>
      expect(liveRegion()).toHaveTextContent("The conversation store cannot be written."),
    );
    expect(ports.showToast).toHaveBeenCalledExactlyOnceWith(
      "The conversation store cannot be written.",
    );
  });

  it("undoes a set from the pane: saves its pages, then restores and deletes pages through the ports, without the flash", async () => {
    let reviews = reviewOf(
      [acceptedAs(keshTor, "Places/Kesh Tor.md"), acceptedAs(saltmere, "Saltmere.md")],
      [{ id: 5, count: 2, undo: true }],
    );
    const restored = [{ path: "Saltmere.md", text: "Mirela is free.\n", version: "v3" }];
    const { argsOf } = mockCore(() => reviews, {
      assistant_undo: () => {
        reviews = reviewOf([
          { ...keshTor, undone: true },
          { ...saltmere, undone: true },
        ]);
        return { restored, deleted: ["Places/Kesh Tor.md"] };
      },
    });
    const ports = renderAssistant({}, 3);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() =>
      expect(ports.pagesDeleted).toHaveBeenCalledExactlyOnceWith(["Places/Kesh Tor.md"]),
    );
    expect(ports.flushPages).toHaveBeenCalledExactlyOnceWith(["Places/Kesh Tor.md", "Saltmere.md"]);
    expect(argsOf("assistant_undo")).toEqual({ set: 5 });
    expect(ports.pagesWritten).toHaveBeenCalledExactlyOnceWith(restored, { flash: false });
    expect(await card("Edit: Saltmere")).toHaveTextContent("Undone");
  });

  it("shows a refused undo as a toast and announces it", async () => {
    const message =
      "“Saltmere” changed since it was written, so nothing was undone. Its history still holds every version.";
    mockCore(
      () => reviewOf([acceptedAs(saltmere, "Saltmere.md")], [{ id: 5, count: 1, undo: true }]),
      {
        assistant_undo: () => {
          throw { kind: "conflict", message };
        },
      },
    );
    const ports = renderAssistant({}, 3);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(liveRegion()).toHaveTextContent(message));
    expect(ports.showToast).toHaveBeenCalledExactlyOnceWith(message);
    expect(ports.pagesWritten).not.toHaveBeenCalled();
  });
});
