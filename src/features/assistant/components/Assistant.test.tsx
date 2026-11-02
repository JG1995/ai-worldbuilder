import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnswerEnd, AnswerEvent, ContextPage, EditorLinks } from "@/types/api";
import { answerChannel, mockAssistantIpc } from "../api/test-ipc";
import { Assistant, type AssistantPorts } from "./Assistant";

type PendingSend = {
  args: Record<string, unknown>;
  send: (event: AnswerEvent) => void;
  end: (end: AnswerEnd) => void;
};

/**
 * Mocks the core with sends that wait for the test to stream and end them, and with the links of
 * an answer's text from `links`, none by default.
 */
function mockPendingSends(
  links: (text: string) => EditorLinks = () => ({ state: "ready", links: [] }),
) {
  const sends: PendingSend[] = [];
  const calls = mockAssistantIpc({
    assistant_send: (args) =>
      new Promise((resolve) => sends.push({ args, send: answerChannel(args), end: resolve })),
    assistant_links: (args) => links(args.text as string),
  });
  /** The calls that sent a message, in order. */
  const sent = () => calls.filter(({ command }) => command === "assistant_send");
  return { calls, sends, sent };
}

function renderAssistant(ports: Partial<AssistantPorts> = {}) {
  const all: AssistantPorts = {
    session: 1,
    activePage: "Places/Kesh Tor.md",
    indexRevision: 0,
    openPage: vi.fn(),
    flushActive: vi.fn(() => Promise.resolve()),
    hasPage: () => true,
    ...ports,
  };
  const element = (ports: AssistantPorts) => (
    <Assistant
      ports={ports}
      model="mistral-small"
      host="api.example.com"
      onOpenSettings={() => {}}
    />
  );
  const { rerender } = render(element(all));
  /** Renders the assistant again as after the world's index changed. */
  const indexChanged = () => rerender(element({ ...all, indexRevision: all.indexRevision + 1 }));
  return { ...all, indexChanged };
}

const composer = () => screen.getByRole("textbox", { name: "Message" });

function sendMessage(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter" });
}

const answers = () => screen.queryAllByRole("textbox", { name: "Answer" });
const announced = (text: string) => expect(screen.getByText(text)).toHaveAttribute("aria-live");

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
    const { calls, sends } = mockPendingSends();
    let saved = () => {};
    renderAssistant({ flushActive: () => new Promise((resolve) => (saved = resolve)) });

    sendMessage("Who lives at Kesh Tor?");

    expect(screen.getByText("Who lives at Kesh Tor?")).toBeInTheDocument();
    expect(composer()).toHaveValue("");
    await act(() => Promise.resolve());
    expect(calls).toEqual([]);
    await act(async () => saved());
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(calls).toEqual([
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
      pending.end({ state: "complete", conversation: 7, text: "Brother Ketil, the monk." }),
    );

    expect(answers()[0]).toHaveTextContent("Brother Ketil, the monk.");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    announced("The answer is complete.");
  });

  it("continues the conversation the core named", async () => {
    const { sends, sent } = mockPendingSends();
    renderAssistant();
    const pending = await startAnswer(sends, "Who lives at Kesh Tor?");
    await act(async () => pending.end({ state: "complete", conversation: 7, text: "A monk." }));

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
    await act(async () => pending.end({ state: "stopped", conversation: 7, text: "Brother" }));

    expect(answers()[0]).toHaveTextContent("Brother");
    expect(screen.getByText("Stopped.")).toBeInTheDocument();
    announced("The answer was stopped.");
  });

  it("puts a refused message back into the composer with the core's reason", async () => {
    mockAssistantIpc({
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
    await act(async () => pending.end({ state: "complete", conversation: 7, text }));
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
    // Nothing is created: the core is asked only to send and for links.
    expect(new Set(calls.map(({ command }) => command))).toEqual(
      new Set(["assistant_send", "assistant_links"]),
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
    await act(async () => pending.end({ state: "complete", conversation: 7, text }));

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(text));
    await waitFor(() => announced("Copied"));
    writeText.mockImplementation(() => Promise.reject(new Error("Denied")));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => announced("The answer could not be copied."));
    vi.unstubAllGlobals();
  });
});
