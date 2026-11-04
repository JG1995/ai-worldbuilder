import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnswerImages, AnswerReview, EditorLink, ImageReview } from "@/types/api";
import {
  type AnswerState,
  type AssistantChat,
  AssistantPane,
  type ChatMessage,
  type ImageActions,
  maxComposerLines,
} from "./AssistantPane";

describe("AssistantPane", () => {
  it("names the model in its header and explains what the assistant sends to the host and that it only proposes changes", () => {
    render(
      <AssistantPane model="mistral-small" host="api.example.com" onOpenSettings={() => {}} />,
    );

    expect(screen.getByRole("heading", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByText("mistral-small")).toBeInTheDocument();
    const explanation = screen.getByText(/sends them, with your message, to api\.example\.com\./);
    expect(explanation).toBeVisible();
    expect(explanation).toHaveTextContent(
      "It can propose changes to pages, which are written only when you accept them.",
    );
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
    acceptFailure: null,
    onAccept: vi.fn(() => Promise.resolve(null)),
    onReject: vi.fn(() => Promise.resolve(true)),
    onUndo: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

type AnswerMessage = Extract<ChatMessage, { role: "answer" }>;

const answer = (id: number, state: AnswerState, text: string): AnswerMessage => ({
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
    expect(screen.queryByText("No answer arrived for this message.")).toBeNull();
  });

  it("shows an answer in the reading view at the assistant's size, with no syntax and no web link", () => {
    renderPane(
      chatWith({
        messages: [
          { id: 1, role: "user", text: "Hello" },
          answer(
            2,
            "complete",
            "**Bold** `code` ![the map](map.png) [site](https://example.com) <https://tide.example> www.ford.example",
          ),
        ],
      }),
    );

    const shown = screen.getByRole("textbox", { name: "Answer" });
    expect(shown).toHaveAttribute("contenteditable", "false");
    expect(shown).toHaveTextContent(
      /^Bold code the map site https:\/\/tide\.example www\.ford\.example$/,
    );
    // Web links show as plain text: no link styling, icon, focus or address.
    expect(
      shown.querySelector("a, [data-link], [data-address], .cm-web-link, .cm-web-icon"),
    ).toBeNull();
    // An image embed shows its name, and no image loads.
    expect(shown.querySelector(".cm-image, .cm-image-placeholder")).toBeNull();
    expect(shown.closest(".assistant")).not.toBeNull();
    expect(shown.closest(".body-reading")).toBeNull();
  });

  it("shows an answer's leading --- block as typed, not hidden as a page's properties", () => {
    renderPane(
      chatWith({
        messages: [
          { id: 1, role: "user", text: "Hello" },
          answer(2, "complete", "---\ntitle: X\n---\nBody"),
        ],
      }),
    );

    const shown = screen.getByRole("textbox", { name: "Answer" });
    expect([...shown.querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual([
      "---",
      "title: X",
      "---",
      "Body",
    ]);
  });

  it("opens no preview of a page an answer links to", async () => {
    vi.useFakeTimers();
    const text = "See [[Kesh Tor]].";
    const link: EditorLink = {
      from: 4,
      to: text.length - 1,
      state: "resolved",
      target: "Kesh Tor",
      path: "Kesh Tor.md",
      heading: null,
      block: null,
    };
    renderPane(
      chatWith({
        messages: [
          { id: 1, role: "user", text: "Hello" },
          { ...answer(2, "complete", text), links: [link] },
        ],
      }),
    );
    const shown = screen.getByRole("textbox", { name: "Answer" });

    fireEvent.mouseOver(within(shown).getByRole("link", { name: "Kesh Tor" }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    vi.useRealTimers();

    expect(document.querySelector(".cm-link-preview")).toBeNull();
  });

  it("says when no answer arrived for a message, offering Retry only on the last one", () => {
    const chat = chatWith({
      messages: [
        { id: 1, role: "user", text: "First" },
        { id: 2, role: "user", text: "Second" },
      ],
    });
    renderPane(chat);

    expect(screen.getAllByText("No answer arrived for this message.")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(chat.onRetry).toHaveBeenCalledOnce();
  });

  const failed: AnswerMessage = {
    ...answer(2, "failed", "Here is the page."),
    failure: { reason: "interrupted", detail: null, providerMessage: null },
  };
  const reviewWith = (state: "pending" | "accepted"): AnswerReview => ({
    answer: 11,
    unreadable: 2,
    unfinished: true,
    proposals: [
      {
        id: 1,
        kind: "new_page",
        path: "Places/Kesh Tor.md",
        page: state === "accepted" ? "Places/Kesh Tor.md" : null,
        state,
        undone: false,
        accept: state === "accepted" ? 5 : null,
        check:
          state === "pending"
            ? {
                state: "applies",
                lines: [{ kind: "added", text: "# Kesh Tor" }],
                version: null,
                changed: false,
              }
            : null,
      },
    ],
    accepted: state === "accepted" ? [{ id: 5, count: 1, undo: true }] : [],
  });

  it("shows an answer's proposals and its notes below its text, and no Retry once a proposal is accepted", () => {
    const { rerender } = renderPane(
      chatWith({
        messages: [
          { id: 1, role: "user", text: "Write Kesh Tor" },
          { ...failed, review: reviewWith("pending") },
        ],
      }),
    );

    expect(screen.getByRole("article", { name: "New page: Kesh Tor" })).toBeInTheDocument();
    expect(screen.getByText("2 proposed changes could not be read.")).toBeInTheDocument();
    expect(
      screen.getByText("The answer ended before a proposed change was complete."),
    ).toBeInTheDocument();
    // The answer's proposal is the pane's newest pending set.
    expect(screen.getByRole("button", { name: "Accept" })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    rerender(
      <AssistantPane
        model="mistral-small"
        onOpenSettings={() => {}}
        chat={chatWith({
          messages: [
            { id: 1, role: "user", text: "Write Kesh Tor" },
            { ...failed, review: reviewWith("accepted") },
          ],
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The connection ended");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("names the kind and page of each proposal begun while the answer arrives", () => {
    renderPane(
      chatWith({
        messages: [
          { id: 1, role: "user", text: "Flesh out Saltmere" },
          {
            ...answer(2, "streaming", "Here you are."),
            proposals: [
              { change: "new_page", path: "Places/Saltmere/Docks" },
              { change: "edit", path: "Places/Saltmere.md" },
            ],
          },
        ],
      }),
    );

    const lines = within(screen.getByRole("list", { name: "Proposed changes" })).getAllByRole(
      "listitem",
    );
    expect(lines.map((line) => line.textContent)).toEqual([
      "Proposing a new page: Places/Saltmere/Docks",
      "Proposing an edit: Places/Saltmere.md",
    ]);
  });

  describe("with images", () => {
    const imageActions = (overrides: Partial<ImageActions> = {}): ImageActions => ({
      url: (image) => `blob:image-${image}`,
      failureText: () => "The reason.",
      approving: [],
      approveFailure: null,
      onApprove: vi.fn(() => Promise.resolve(true)),
      onRegenerate: vi.fn(),
      onReject: vi.fn(() => Promise.resolve(true)),
      onGenerate: vi.fn(() => Promise.resolve(true)),
      onCancel: vi.fn(),
      onCopyEmbed: vi.fn(),
      onUndo: vi.fn(() => Promise.resolve(true)),
      ...overrides,
    });
    const image = (id: number, state: ImageReview["state"], name = `Image ${id}`): ImageReview => ({
      id,
      name,
      frame: "square",
      prompt: `A prompt for ${name}`,
      state,
      notGenerated: state === "not_generated" ? "over_limit" : null,
      failure: null,
      undone: false,
      path: state === "approved" ? `images/${name}.png` : null,
      undo: state === "approved",
      revises: null,
      revisesName: null,
      reference: null,
    });
    const imagesOf = (
      answer: number,
      images: ImageReview[],
      notes = { unreadable: 0, unfinished: false },
    ): AnswerImages => ({ answer, ...notes, images });
    /** A saved answer with its images, and its proposals when `review` is given. */
    const withImages = (id: number, images: ImageReview[], review?: AnswerReview) => ({
      ...answer(id, "complete", `Answer ${id}`),
      review,
      images: imagesOf(id, images),
    });
    const pane = (chat: AssistantChat) => (
      <AssistantPane model="mistral-small" onOpenSettings={() => {}} chat={chat} />
    );
    /** The cards holding an accent-filled button. */
    const primaries = () =>
      [...document.querySelectorAll("button.bg-accent")].map((button) =>
        button.closest("article")?.getAttribute("aria-label"),
      );

    it("shows an answer's image cards after its proposals, and the empty conversation says images go to openrouter.ai", () => {
      const { unmount } = renderPane(chatWith({ images: imageActions() }));
      expect(screen.getByText(/sends them, with your message/)).toHaveTextContent(
        "When you ask for an image, it sends the image's prompt to openrouter.ai, and the image is saved in this world only when you approve it.",
      );
      unmount();

      renderPane(
        chatWith({
          images: imageActions(),
          messages: [
            { id: 1, role: "user", text: "Write Kesh Tor and draw it" },
            withImages(
              2,
              [image(5, "pending", "Kesh Tor"), image(6, "generating")],
              reviewWith("pending"),
            ),
          ],
        }),
      );

      const cards = screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"));
      expect(cards).toEqual(["New page: Kesh Tor", "Image: Kesh Tor", "Image: Image 6"]);
      expect(screen.getByRole("img", { name: "Kesh Tor" })).toHaveAttribute("src", "blob:image-5");
    });

    it("gives the one primary button to the newest answer with anything pending: its Accept, else its first pending image's Approve", () => {
      const messages = (newest: ChatMessage): ChatMessage[] => [
        { id: 1, role: "user", text: "Draw two" },
        withImages(2, [image(5, "pending"), image(6, "pending")]),
        { id: 3, role: "user", text: "Write and draw" },
        newest,
      ];
      const chat = (newest: ChatMessage) =>
        chatWith({ images: imageActions(), messages: messages(newest) });
      const { rerender } = renderPane(
        chat(withImages(4, [image(7, "pending")], reviewWith("pending"))),
      );
      expect(primaries()).toEqual(["New page: Kesh Tor"]);

      rerender(
        pane(
          chat(withImages(4, [image(7, "approved"), image(8, "pending")], reviewWith("accepted"))),
        ),
      );
      expect(primaries()).toEqual(["Image: Image 8"]);

      rerender(pane(chat(withImages(4, [image(7, "rejected")], reviewWith("accepted")))));
      expect(primaries()).toEqual(["Image: Image 5"]);

      // A pending proposal that no longer applies cannot be accepted, so the image keeps the light.
      const stale = reviewWith("pending");
      stale.proposals[0].check = { state: "no_longer_applies", reason: "The page exists." };
      rerender(pane(chat(withImages(4, [image(7, "pending")], stale))));
      expect(primaries()).toEqual(["Image: Image 7"]);
    });

    it("offers no Retry on a failed answer whose image is approved or being approved", () => {
      const failedWith = (state: ImageReview["state"]): ChatMessage[] => [
        { id: 1, role: "user", text: "Draw Kesh Tor" },
        { ...failed, images: imagesOf(11, [image(5, state)]) },
      ];
      const { rerender } = renderPane(
        chatWith({ images: imageActions(), messages: failedWith("pending") }),
      );
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

      rerender(
        pane(
          chatWith({ images: imageActions({ approving: [5] }), messages: failedWith("pending") }),
        ),
      );
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      rerender(pane(chatWith({ images: imageActions(), messages: failedWith("approved") })));
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("notes unreadable and unfinished image requests, and names the images begun while an answer arrives and a regeneration's image", () => {
      renderPane(
        chatWith({
          images: imageActions(),
          messages: [
            { id: 1, role: "user", text: "Older", regenerates: "Harbourmaster Oslo" },
            {
              ...answer(2, "complete", "Here."),
              images: imagesOf(2, [], { unreadable: 2, unfinished: true }),
            },
            { id: 3, role: "user", text: "Draw the quay" },
            { ...answer(4, "streaming", "Drawing."), requestedImages: ["The quay", "The gull"] },
          ],
        }),
      );

      expect(screen.getByText("Older")).toHaveTextContent(
        "Regenerates the image “Harbourmaster Oslo”Older",
      );
      expect(screen.getByText("2 requested images could not be read.")).toBeInTheDocument();
      expect(
        screen.getByText("The answer ended before an image request was complete."),
      ).toBeInTheDocument();
      const lines = within(screen.getByRole("list", { name: "Requested images" })).getAllByRole(
        "listitem",
      );
      expect(lines.map((line) => line.textContent)).toEqual([
        "Requesting an image: The quay",
        "Requesting an image: The gull",
      ]);
    });

    it("moves focus after a reject to the answer's next pending card, else to the composer", async () => {
      renderPane(
        chatWith({
          images: imageActions(),
          messages: [
            { id: 1, role: "user", text: "Draw three" },
            withImages(2, [image(5, "pending"), image(6, "approved"), image(7, "pending")]),
          ],
        }),
      );
      const reject = (card: string) =>
        within(screen.getByRole("article", { name: card })).getByRole("button", {
          name: "Reject",
        });

      await act(async () => fireEvent.click(reject("Image: Image 5")));
      expect(screen.getByRole("article", { name: "Image: Image 7" })).toHaveFocus();
      await act(async () => fireEvent.click(reject("Image: Image 7")));
      expect(composer()).toHaveFocus();
    });
  });
});

describe("AssistantPane's conversations", () => {
  it("has New conversation and Conversations in its header only when given them", () => {
    const onNewConversation = vi.fn();
    const onShowConversations = vi.fn();
    const { unmount } = render(
      <AssistantPane
        model="mistral-small"
        onOpenSettings={() => {}}
        onNewConversation={onNewConversation}
        onShowConversations={onShowConversations}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(onShowConversations).toHaveBeenCalledOnce();
    unmount();

    renderPane(chatWith());
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversations" })).toBeNull();
  });

  it("lists each conversation's title and latest time in place of the conversation, and opens one", () => {
    const onOpen = vi.fn();
    const updated = 1_700_000_000;
    render(
      <AssistantPane
        model="mistral-small"
        onOpenSettings={() => {}}
        chat={chatWith({ messages: [{ id: 1, role: "user", text: "Shown before" }] })}
        conversations={{
          items: [{ id: 5, title: "The glass storm", updated }],
          error: null,
          onOpen,
          onDelete: vi.fn(),
          onBack: vi.fn(),
        }}
      />,
    );

    expect(screen.queryByText("Shown before")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    const time = new Date(updated * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const row = screen.getByRole("button", { name: /^The glass storm/ });
    expect(screen.getByText("The glass storm")).toHaveClass("ui-strong");
    expect(screen.getByText(time)).toHaveClass("ui-small", "text-text-muted");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("says in the delete confirmation that changes already accepted stay in the world", () => {
    render(
      <AssistantPane
        model="mistral-small"
        onOpenSettings={() => {}}
        conversations={{
          items: [{ id: 5, title: "The glass storm", updated: 1_700_000_000 }],
          error: null,
          onOpen: vi.fn(),
          onDelete: vi.fn(),
          onBack: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));

    expect(screen.getByRole("dialog", { name: 'Delete "The glass storm"?' })).toHaveTextContent(
      "cannot be undone. Changes you already accepted stay in the world.",
    );
  });
});
