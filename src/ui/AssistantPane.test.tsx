import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type AnswerState,
  type AssistantChat,
  AssistantPane,
  type ChatMessage,
  maxComposerLines,
} from "./AssistantPane";

describe("AssistantPane", () => {
  it("names the model in its header and explains what the assistant sends to the host", () => {
    render(
      <AssistantPane model="mistral-small" host="api.example.com" onOpenSettings={() => {}} />,
    );

    expect(screen.getByRole("heading", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByText("mistral-small")).toBeInTheDocument();
    expect(screen.getByText(/sends them, with your message, to api\.example\.com\./)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("asks for a provider without one, and its Settings button opens Settings", () => {
    const onOpenSettings = vi.fn();
    render(<AssistantPane onOpenSettings={onOpenSettings} />);

    expect(screen.getByRole("heading", { name: "Assistant" }).parentElement).toHaveTextContent(
      /^Assistant$/,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add a provider in Settings to use the assistant.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

function chatWith(overrides: Partial<AssistantChat> = {}): AssistantChat {
  return {
    messages: [],
    draft: "",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
    onOpenPage: vi.fn(),
    onFollowLink: vi.fn(),
    onCopy: vi.fn(),
    refusal: null,
    announcement: "",
    ...overrides,
  };
}

const answer = (id: number, state: AnswerState, text: string): ChatMessage => ({
  id,
  role: "answer",
  text,
  state,
  context: null,
  failure: null,
});

function renderPane(chat: AssistantChat) {
  return render(<AssistantPane model="mistral-small" onOpenSettings={() => {}} chat={chat} />);
}

const composer = () => screen.getByRole("textbox", { name: "Message" });

describe("AssistantPane's composer", () => {
  it("sends on Enter and leaves Shift+Enter to add a line", () => {
    const chat = chatWith({ draft: "Who lives at Kesh Tor?" });
    renderPane(chat);

    expect(fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true })).toBe(true);
    expect(chat.onSend).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(composer(), { key: "Enter" })).toBe(false);
    expect(chat.onSend).toHaveBeenCalledOnce();
  });

  it("cannot send a blank message, nor any without a provider", () => {
    const blank = chatWith({ draft: " \n " });
    const { unmount } = renderPane(blank);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(blank.onSend).not.toHaveBeenCalled();
    unmount();

    // Without a provider, the conversation stays readable and there is no composer.
    render(
      <AssistantPane
        onOpenSettings={() => {}}
        chat={chatWith({ messages: [{ id: 1, role: "user", text: "Hello" }] })}
      />,
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows Stop while an answer arrives, and Enter does not send meanwhile", () => {
    const chat = chatWith({
      draft: "Next question",
      messages: [{ id: 1, role: "user", text: "Hello" }, answer(2, "streaming", "Hi")],
    });
    renderPane(chat);

    fireEvent.keyDown(composer(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(chat.onSend).not.toHaveBeenCalled();
    expect(chat.onStop).toHaveBeenCalledOnce();
  });

  it("grows a line at a time while its text overflows, up to 8 lines", () => {
    const lineHeight = 20;
    let textHeight = 3 * lineHeight;
    // jsdom has no layout: the field is as tall as its rows, and its text as tall as set here.
    vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      return this.rows * lineHeight;
    });
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(
      () => textHeight,
    );

    const { rerender } = renderPane(chatWith({ draft: "three lines" }));
    expect(composer()).toHaveAttribute("rows", "3");

    textHeight = 12 * lineHeight;
    rerender(
      <AssistantPane
        model="mistral-small"
        onOpenSettings={() => {}}
        chat={chatWith({ draft: "twelve lines" })}
      />,
    );
    expect(maxComposerLines).toBe(8);
    expect(composer()).toHaveAttribute("rows", "8");
    vi.restoreAllMocks();
  });
});

describe("AssistantPane's answers", () => {
  it("marks a stopped and a cut-off answer, and shows an answer's Markdown as text", () => {
    renderPane(
      chatWith({
        messages: [
          { id: 1, role: "user", text: "Hello" },
          answer(2, "stopped", "So far <b>bold</b>"),
          { id: 3, role: "user", text: "More" },
          answer(4, "cut_off", "Long"),
        ],
      }),
    );

    expect(screen.getByText("Stopped.")).toBeInTheDocument();
    expect(screen.getByText("Cut off: the answer was too long.")).toBeInTheDocument();
    const [stopped] = screen.getAllByRole("textbox", { name: "Answer" });
    expect(stopped).toHaveTextContent("So far <b>bold</b>");
    expect(stopped.querySelector("b")).toBeNull();
  });
});
