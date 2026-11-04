import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ImageReview } from "@/types/api";
import { ImageCard } from "./ImageCard";

const image = (overrides: Partial<ImageReview> = {}): ImageReview => ({
  id: 4,
  name: "Harbourmaster <b>Oslo</b>",
  frame: "portrait",
  prompt: "Ink drawing of a <i>harbourmaster</i>.",
  state: "pending",
  notGenerated: null,
  failure: null,
  undone: false,
  path: null,
  undo: false,
  revises: null,
  revisesName: null,
  reference: null,
  ...overrides,
});

type Props = ComponentProps<typeof ImageCard>;

function renderCard(overrides: Partial<Props> = {}) {
  const props: Props = {
    image: image(),
    url: "blob:sample",
    primary: false,
    running: false,
    failureText: null,
    approveFailure: null,
    onApprove: vi.fn(() => Promise.resolve(true)),
    onRegenerate: vi.fn(),
    onReject: vi.fn(),
    onGenerate: vi.fn(() => Promise.resolve(true)),
    onCancel: vi.fn(),
    onCopyEmbed: vi.fn(),
    onUndo: vi.fn(() => Promise.resolve(true)),
    onOpenSettings: vi.fn(),
    onFocusComposer: vi.fn(),
    ...overrides,
  };
  const view = render(<ImageCard {...props} />);
  const show = (next: Partial<ImageReview>) =>
    view.rerender(<ImageCard {...props} image={image(next)} />);
  return { props, show };
}

const card = () => screen.getByRole("article", { name: "Image: Harbourmaster <b>Oslo</b>" });
/** Whether the card has exactly the buttons named `names`. */
function expectButtons(names: string[]) {
  expect(within(card()).queryAllByRole("button")).toHaveLength(names.length);
  for (const name of names) expect(within(card()).getByRole("button", { name })).toBeVisible();
}

describe("ImageCard", () => {
  it.each<[string, Partial<ImageReview>, string, string[]]>([
    [
      "pending",
      {},
      "Pending",
      ["Harbourmaster <b>Oslo</b>", "Prompt", "Approve", "Regenerate", "Reject"],
    ],
    ["generating", { state: "generating" }, "Generating", ["Prompt", "Cancel"]],
    [
      "not generated",
      { state: "not_generated", notGenerated: "over_limit" },
      "Not generated",
      ["Prompt", "Generate"],
    ],
    [
      "approved",
      { state: "approved", path: "images/Oslo.png", undo: true },
      "Approved",
      ["Harbourmaster <b>Oslo</b>", "Prompt", "Copy embed", "Undo"],
    ],
    ["rejected", { state: "rejected" }, "Rejected", []],
  ])("shows a %s image's state and its actions", (_state, shown, state, actions) => {
    renderCard({ image: image(shown) });

    expect(within(card()).getByText("Image")).toBeVisible();
    expect(within(card()).getByText(state)).toBeVisible();
    expectButtons(actions);
  });

  it("shows the thumbnail as a button named by the image, at its natural ratio, which opens the lightbox", () => {
    renderCard();

    const thumbnail = within(card()).getByRole("button", { name: "Harbourmaster <b>Oslo</b>" });
    expect(within(thumbnail).getByRole("img")).toHaveAttribute("src", "blob:sample");
    fireEvent.click(thumbnail);

    expect(screen.getByRole("dialog", { name: "Harbourmaster <b>Oslo</b>" })).toBeInTheDocument();
  });

  it("discloses the exact prompt as text, and what a regeneration did with the earlier image", () => {
    renderCard({
      image: image({ revises: 3, revisesName: "Oslo", reference: "not_taken" }),
    });

    const disclosure = screen.getByRole("button", { name: "Prompt" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);

    expect(screen.getByText("Ink drawing of a <i>harbourmaster</i>.")).toBeVisible();
    expect(
      screen.getByText(
        "It regenerates “Oslo”. That image was not sent: the image model takes no image input.",
      ),
    ).toBeVisible();
  });

  it("says why an image was not generated, with Settings when no image provider is saved", () => {
    const { props } = renderCard({
      image: image({ state: "not_generated", notGenerated: "no_provider" }),
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Add an image provider in Settings to generate images.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it.each([
    ["key_refused", "error"],
    ["rate_limited", "warning"],
  ] as const)(
    "shows a %s failure as an %s notice with the provider's message as text",
    (reason, status) => {
      renderCard({
        image: image({
          state: "not_generated",
          notGenerated: "failed",
          failure: { reason, detail: null, providerMessage: "Nope, <b>no</b>." },
        }),
        failureText: "The reason.",
      });

      const notice = screen.getByRole("alert");
      expect(notice).toHaveClass(`border-${status}`);
      expect(notice).toHaveTextContent("The reason.The provider's message: Nope, <b>no</b>.");
    },
  );

  it("marks an undone image as approvable again, and says why its last approval failed", () => {
    renderCard({ image: image({ undone: true }), approveFailure: "The world is read-only" });

    expect(card()).toHaveTextContent("Undone; it can be approved again");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The image could not be saved: The world is read-only.",
    );
  });

  it("makes Approve the primary button only when asked", () => {
    const { show } = renderCard({ primary: true });
    expect(screen.getByRole("button", { name: "Approve" })).toHaveClass("bg-accent");

    show({ state: "approved", path: "images/Oslo.png" });
    expect(card().querySelector(".bg-accent")).toBeNull();
  });

  it("moves focus after Approve to Undo, or to the saved path without one, and after Undo to Approve", async () => {
    const { show } = renderCard();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve" })));
    show({ state: "approved", path: "images/Oslo.png", undo: true });
    expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    show({ undone: true });
    expect(screen.getByRole("button", { name: "Approve" })).toHaveFocus();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve" })));
    show({ state: "approved", path: "images/Oslo.png", undo: false });
    expect(screen.getByText("Saved as images/Oslo.png")).toHaveFocus();
  });

  it("moves focus after Generate to Cancel", async () => {
    const { show } = renderCard({
      image: image({ state: "not_generated", notGenerated: "cancelled" }),
    });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
    show({ state: "generating" });

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("opens the change box focused, sends a change with Enter and returns focus to the composer", () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const change = screen.getByRole("textbox", { name: "Change" });
    expect(change).toHaveFocus();
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.change(change, { target: { value: " \n " } });
    expect(send).toBeDisabled();
    fireEvent.keyDown(change, { key: "Enter" });
    expect(props.onRegenerate).not.toHaveBeenCalled();

    fireEvent.change(change, { target: { value: "Older, with a grey beard" } });
    expect(fireEvent.keyDown(change, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.keyDown(change, { key: "Enter" });

    expect(props.onRegenerate).toHaveBeenCalledExactlyOnceWith("Older, with a grey beard");
    expect(props.onFocusComposer).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Change" })).toBeNull();
  });

  it("cannot send a change while an answer is running, and Escape or Cancel close the box onto Regenerate", () => {
    const outside = vi.fn();
    const { props } = renderCard({ running: true });
    document.addEventListener("keydown", outside);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Change" }), {
      target: { value: "Older" },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Change" }), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Regenerate" })).toHaveFocus();
    expect(outside).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Regenerate" })).toHaveFocus();
    expect(props.onRegenerate).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });

  it("runs an action taken in the lightbox after closing it, and Regenerate there opens the change box", async () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Harbourmaster <b>Oslo</b>" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reject" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onReject).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Harbourmaster <b>Oslo</b>" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Regenerate" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Change" })).toHaveFocus();
  });
});
