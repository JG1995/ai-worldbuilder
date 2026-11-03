import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AcceptFailure,
  AnswerReview,
  DiffLine,
  ProposalReview as Proposal,
} from "@/types/api";
import { ProposalReview } from "./ProposalReview";

const edit: Proposal = {
  id: 1,
  kind: "edit",
  path: "saltmere",
  page: "Places/Saltmere.md",
  state: "pending",
  undone: false,
  accept: null,
  check: {
    state: "applies",
    lines: [
      { kind: "same", text: "# Saltmere" },
      { kind: "removed", text: "Mirela is free." },
      { kind: "added", text: "Mirela is <b>captured</b>." },
    ],
    version: "v1",
    changed: false,
  },
};

const newPage = (id: number, path: string): Proposal => ({
  id,
  kind: "new_page",
  path,
  page: null,
  state: "pending",
  undone: false,
  accept: null,
  check: {
    state: "applies",
    lines: [{ kind: "added", text: "# A page" }],
    version: null,
    changed: false,
  },
});

const reviewOf = (
  proposals: Proposal[],
  accepted: AnswerReview["accepted"] = [],
): AnswerReview => ({
  answer: 11,
  unreadable: 0,
  unfinished: false,
  proposals,
  accepted,
});

function renderReview(
  review: AnswerReview,
  {
    newest = true,
    failure = null,
    onAccept = vi.fn(() => Promise.resolve<number | null>(null)),
    onReject = vi.fn(() => Promise.resolve(true)),
    onUndo = vi.fn(() => Promise.resolve(true)),
  }: {
    newest?: boolean;
    failure?: AcceptFailure | null;
    onAccept?: (ids: number[]) => Promise<number | null>;
    onReject?: (id: number) => Promise<boolean>;
    onUndo?: (set: number) => Promise<boolean>;
  } = {},
) {
  const handlers = { onAccept, onReject, onUndo, onOpenPage: vi.fn(), onFocusComposer: vi.fn() };
  const element = (shown: AnswerReview) => (
    <ProposalReview review={shown} newest={newest} failure={failure} {...handlers} />
  );
  const { rerender, unmount } = render(element(review));
  return { ...handlers, unmount, reviewed: (next: AnswerReview) => rerender(element(next)) };
}

const card = (name: string) => screen.getByRole("article", { name });

describe("ProposalReview", () => {
  it("shows one proposal as a card with its title, folder, kind and diff, with spoken prefixes", () => {
    const { onOpenPage, onAccept } = renderReview(reviewOf([edit]));

    const shown = card("Edit: Saltmere");
    expect(within(shown).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept selected" })).toBeNull();
    expect(shown).toHaveTextContent("Places");
    // Proposal text shows as text, never as markup.
    expect(within(shown).getByText("Mirela is <b>captured</b>.")).toBeInTheDocument();
    expect(shown.querySelector("b")).toBeNull();
    expect(within(shown).getByText("Only in the proposal:")).toHaveClass("sr-only");
    expect(within(shown).getByText("Only in the page now:")).toHaveClass("sr-only");
    fireEvent.click(within(shown).getByRole("button", { name: "Saltmere" }), { ctrlKey: true });
    expect(onOpenPage).toHaveBeenCalledExactlyOnceWith("Places/Saltmere.md", { newTab: true });
    fireEvent.click(within(shown).getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledExactlyOnceWith([1]);
  });

  it("shows several as a batch list with the summary, every one that applies ticked, and sends exactly the ticked ones", () => {
    const gone: Proposal = {
      ...edit,
      id: 4,
      page: null,
      path: "Places/Gone.md",
      check: { state: "no_longer_applies", reason: "The page does not exist." },
    };
    const { onAccept } = renderReview(
      reviewOf([newPage(2, "Places/Kesh Tor"), newPage(3, "Places/Glass Road.md"), edit, gone]),
    );

    expect(screen.getByText("2 new pages, 2 edits")).toBeInTheDocument();
    expect(within(card("New page: Kesh Tor")).getByRole("checkbox")).toBeChecked();
    expect(within(card("Edit: Saltmere")).getByRole("checkbox")).toBeChecked();
    // One that no longer applies says why and can be neither ticked nor accepted.
    const goneCard = card("Edit: Gone");
    expect(goneCard).toHaveTextContent("This change no longer applies: The page does not exist.");
    expect(within(goneCard).getByRole("checkbox")).not.toBeChecked();
    expect(within(goneCard).getByRole("checkbox")).toBeDisabled();
    expect(within(goneCard).getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(within(goneCard).getByRole("button", { name: "Reject" })).toBeEnabled();
    // Without a page to open, its title is plain text.
    expect(within(goneCard).queryByRole("button", { name: "Gone" })).toBeNull();

    fireEvent.click(within(card("New page: Glass Road")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    expect(onAccept).toHaveBeenCalledExactlyOnceWith([2, 1]);

    fireEvent.click(within(card("New page: Kesh Tor")).getByRole("checkbox"));
    fireEvent.click(within(card("Edit: Saltmere")).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Accept selected" })).toBeDisabled();
  });

  it("makes only the newest pending set's Accept or Accept selected primary", () => {
    const { unmount } = renderReview(reviewOf([edit]), { newest: false });
    expect(screen.getByRole("button", { name: "Accept" })).not.toHaveClass("bg-accent");
    unmount();

    renderReview(reviewOf([edit, newPage(2, "Kesh Tor")]));
    expect(screen.getByRole("button", { name: "Accept selected" })).toHaveClass("bg-accent");
    for (const accept of screen.getAllByRole("button", { name: "Accept" })) {
      expect(accept).not.toHaveClass("bg-accent");
    }
  });

  it("warns when the page changed since the proposal was made, and Accept stays available", () => {
    const check = { ...edit.check, changed: true } as Proposal["check"];
    renderReview(reviewOf([{ ...edit, check }]));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This page changed since the proposal was made.",
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("collapses a diff longer than 12 lines until Show all", () => {
    const lines: DiffLine[] = Array.from({ length: 15 }, (_, index) => ({
      kind: "added",
      text: `Line ${index + 1}`,
    }));
    renderReview(
      reviewOf([
        {
          ...newPage(2, "Long"),
          check: { state: "applies", lines, version: null, changed: false },
        },
      ]),
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.queryByText("Line 13")).toBeNull();
    const showAll = screen.getByRole("button", { name: "Show all" });
    expect(showAll).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(showAll);

    expect(screen.getAllByRole("listitem")).toHaveLength(15);
    expect(screen.getByText("Line 15")).toBeInTheDocument();
  });

  it("collapses settled cards to their header and state, marks an undone one, and offers Undo once per set", () => {
    const accepted = {
      ...newPage(2, "Places/Kesh Tor.md"),
      state: "accepted",
      accept: 5,
      check: null,
    } as const;
    const rejected = { ...newPage(3, "Glass Road"), state: "rejected", check: null } as const;
    const undone = { ...edit, undone: true };
    const { onUndo } = renderReview(
      reviewOf([accepted, rejected, undone], [{ id: 5, count: 1, undo: true }]),
    );

    expect(card("New page: Kesh Tor")).toHaveTextContent("Accepted");
    expect(within(card("New page: Kesh Tor")).queryByRole("button")).toBeNull();
    expect(within(card("New page: Kesh Tor")).queryByRole("checkbox")).toBeNull();
    expect(card("New page: Glass Road")).toHaveTextContent("Rejected");
    expect(card("Edit: Saltmere")).toHaveTextContent("Undone; it can be accepted again");
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toHaveAccessibleDescription("Accepted 1 change");
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("shows a set whose change cannot be undone without Undo", () => {
    const accepted = { ...edit, state: "accepted", accept: 5, check: null } as const;
    renderReview(reviewOf([accepted], [{ id: 5, count: 1, undo: false }]));

    expect(screen.getByText("Accepted 1 change")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows a write failure on its card only", () => {
    renderReview(reviewOf([newPage(2, "Kesh Tor"), edit]), {
      failure: { proposal: 1, message: "The page is read-only." },
    });

    expect(card("Edit: Saltmere")).toHaveTextContent(
      "This change could not be written: The page is read-only.",
    );
    expect(within(card("New page: Kesh Tor")).queryByRole("alert")).toBeNull();
  });

  it("moves focus to the accepted set's Undo after an accept", async () => {
    const { reviewed } = renderReview(reviewOf([edit]), {
      onAccept: () => Promise.resolve(5),
    });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Accept" })));
    reviewed(
      reviewOf(
        [{ ...edit, state: "accepted", accept: 5, check: null }],
        [{ id: 5, count: 1, undo: true }],
      ),
    );

    expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
  });

  it("keeps focus where it was after a refused accept", async () => {
    renderReview(reviewOf([edit]));
    const accept = screen.getByRole("button", { name: "Accept" });
    accept.focus();

    await act(async () => fireEvent.click(accept));

    expect(accept).toHaveFocus();
  });

  it("moves focus to the next pending proposal after a reject, or to the composer when none is left", async () => {
    const first = newPage(2, "Kesh Tor");
    const { reviewed, onFocusComposer } = renderReview(reviewOf([first, edit]));

    await act(async () =>
      fireEvent.click(within(card("New page: Kesh Tor")).getByRole("button", { name: "Reject" })),
    );
    const rejected = { ...first, state: "rejected", check: null } as const;
    reviewed(reviewOf([rejected, edit]));
    expect(card("Edit: Saltmere")).toHaveFocus();

    await act(async () =>
      fireEvent.click(within(card("Edit: Saltmere")).getByRole("button", { name: "Reject" })),
    );
    expect(onFocusComposer).toHaveBeenCalledOnce();
  });

  it("moves focus to the first proposal an undo returned to pending", async () => {
    const accepted = { ...edit, state: "accepted", accept: 5, check: null } as const;
    const { reviewed } = renderReview(reviewOf([accepted], [{ id: 5, count: 1, undo: true }]));

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    reviewed(reviewOf([{ ...edit, undone: true }]));

    expect(card("Edit: Saltmere")).toHaveFocus();
  });
});
