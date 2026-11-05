import { useEffect, useId, useRef, useState } from "react";
import type {
  AcceptedSet,
  AcceptFailure,
  AnswerReview,
  ProposalReview as Proposal,
  ProposalKind,
} from "@/types/api";
import { Button } from "./Button";
import { DiffLines } from "./DiffLines";
import { Icon, type IconName } from "./Icon";
import { Notice } from "./Notice";

type ProposalReviewProps = {
  /** One answer's proposals, as the core reviewed them, with its accepted sets. */
  review: AnswerReview;
  /** It holds the pane's newest pending set, whose Accept or Accept selected is then primary. */
  newest: boolean;
  /** Why the last accept stopped at one of this answer's proposals, shown on that card. */
  failure: AcceptFailure | null;
  /** Accepts the proposals `ids` as one change; resolves with its set, or null when none was written. */
  onAccept: (ids: number[]) => Promise<number | null>;
  /** Rejects a proposal; resolves with whether it was rejected. */
  onReject: (id: number) => Promise<boolean>;
  /** Undoes an accepted set; resolves with whether it was undone. */
  onUndo: (set: number) => Promise<boolean>;
  onOpenPage: (path: string, options: { newTab: boolean }) => void;
  /** Focuses the composer, once no pending proposal is left to focus after a reject. */
  onFocusComposer: () => void;
};

/** A longer diff shows this many lines until Show all. */
export const collapsedLines = 12;

const kindLabels: Record<ProposalKind, string> = { new_page: "New page", edit: "Edit" };

/** What takes focus once the review shows the result of an action. */
type FocusTarget = { set: number } | { proposal: number };

const appliesNow = (proposal: Proposal) =>
  proposal.state === "pending" && proposal.check?.state === "applies";

/**
 * One answer's proposals: a card for a single one, or a batch list with a summary, a checkbox per
 * pending proposal that applies, all ticked at first, and Accept selected. Each pending card shows
 * its diff against the page as it is now, why it no longer applies or that its page changed, and
 * Accept and Reject; settled cards collapse to their header and state, and each accepted set has
 * Undo while its change can be undone. Proposal text and paths show only as text.
 */
export function ProposalReview({
  review,
  newest,
  failure,
  onAccept,
  onReject,
  onUndo,
  onOpenPage,
  onFocusComposer,
}: ProposalReviewProps) {
  // Unticked rather than ticked, so that every proposal that applies starts ticked, including one
  // that an undo returns to pending.
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set());
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { proposals, accepted } = review;
  const batch = proposals.length > 1;
  const ticked = proposals.filter((proposal) => appliesNow(proposal) && !unticked.has(proposal.id));
  const anyPending = proposals.some((proposal) => proposal.state === "pending");

  // The target shows once the review read after the action arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new review can bring the target.
  useEffect(() => {
    if (!focusTarget) return;
    const selector =
      "set" in focusTarget
        ? `[data-set="${focusTarget.set}"]`
        : `[data-proposal="${focusTarget.proposal}"]`;
    const target = root.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.focus();
    setFocusTarget(null);
  }, [focusTarget, review]);

  if (proposals.length === 0) return null;

  async function accept(ids: number[]) {
    const set = await onAccept(ids);
    if (set !== null) setFocusTarget({ set });
  }

  async function reject(id: number) {
    const at = proposals.findIndex((proposal) => proposal.id === id);
    const pendingOther = (proposal: Proposal) => proposal.state === "pending" && proposal.id !== id;
    const next =
      proposals.slice(at + 1).find(pendingOther) ??
      proposals.slice(0, at).reverse().find(pendingOther);
    if (!(await onReject(id))) return;
    if (next) setFocusTarget({ proposal: next.id });
    else onFocusComposer();
  }

  async function undo(set: number) {
    const first = proposals.find((proposal) => proposal.accept === set);
    if ((await onUndo(set)) && first) setFocusTarget({ proposal: first.id });
  }

  function tick(id: number, on: boolean) {
    setUnticked((current) => {
      const next = new Set(current);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div ref={root} className="flex flex-col gap-2">
      {batch && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="ui-strong text-text">{summaryOf(proposals)}</p>
          {anyPending && (
            <Button
              variant={newest ? "primary" : "secondary"}
              disabled={ticked.length === 0}
              onClick={() => void accept(ticked.map(({ id }) => id))}
            >
              Accept selected
            </Button>
          )}
        </div>
      )}
      {proposals.map((proposal) => (
        <Card
          key={proposal.id}
          proposal={proposal}
          selection={
            batch
              ? {
                  ticked: appliesNow(proposal) && !unticked.has(proposal.id),
                  onTick: (on) => tick(proposal.id, on),
                }
              : null
          }
          primary={!batch && newest}
          failure={failure?.proposal === proposal.id ? failure.message : null}
          onAccept={() => void accept([proposal.id])}
          onReject={() => void reject(proposal.id)}
          onOpenPage={onOpenPage}
        />
      ))}
      {accepted.map((set) => (
        <SetRow key={set.id} set={set} onUndo={() => void undo(set.id)} />
      ))}
    </div>
  );
}

function Card({
  proposal,
  selection,
  primary,
  failure,
  onAccept,
  onReject,
  onOpenPage,
}: {
  proposal: Proposal;
  /** Its checkbox in a batch list; null for a single card. */
  selection: { ticked: boolean; onTick: (on: boolean) => void } | null;
  primary: boolean;
  /** Why its write failed in the last accept. */
  failure: string | null;
  onAccept: () => void;
  onReject: () => void;
  onOpenPage: ProposalReviewProps["onOpenPage"];
}) {
  const [expanded, setExpanded] = useState(false);
  const { kind, page, state, undone, check } = proposal;
  const shownPath = page ?? proposal.path;
  const name = pageName(shownPath);
  const folder = shownPath.includes("/") ? shownPath.slice(0, shownPath.lastIndexOf("/")) : null;
  const kindLabel = kindLabels[kind];
  const pending = state === "pending";
  const applies = appliesNow(proposal);
  const lines = check?.state === "applies" ? check.lines : [];

  return (
    <article
      data-proposal={proposal.id}
      tabIndex={-1}
      aria-label={`${kindLabel}: ${name}`}
      // The border shows the card in light mode, where raised is as white as page.
      className="flex flex-col overflow-hidden rounded-md border border-divider bg-raised"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        {selection && pending && (
          <input
            type="checkbox"
            aria-label={`Select ${name}`}
            checked={selection.ticked}
            disabled={!applies}
            onChange={(change) => selection.onTick(change.currentTarget.checked)}
            className="accent-accent"
          />
        )}
        {kind === "edit" && page !== null ? (
          <button
            type="button"
            onClick={(event) => onOpenPage(page, { newTab: event.ctrlKey || event.metaKey })}
            // Chromium fires no click for Ctrl+Enter on a button.
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onOpenPage(page, { newTab: event.ctrlKey || event.metaKey });
            }}
            className="ui-strong min-w-0 break-words rounded-sm text-left text-accent underline transition-colors hover:text-accent-hover"
          >
            {name}
          </button>
        ) : (
          <span className="ui-strong min-w-0 break-words text-text">{name}</span>
        )}
        {folder && <span className="ui-small min-w-0 break-words text-text-muted">{folder}</span>}
        <span className="ui-small text-text-muted">{kindLabel}</span>
        {state === "accepted" && <Mark icon="check_circle" colour="text-success" text="Accepted" />}
        {state === "rejected" && <Mark icon="close" colour="text-text-muted" text="Rejected" />}
        {pending && undone && (
          <Mark icon="info" colour="text-info" text="Undone; it can be accepted again" />
        )}
      </div>
      {pending && (
        <>
          {lines.length > 0 && (
            <div className="assistant">
              <DiffLines
                lines={expanded ? lines : lines.slice(0, collapsedLines)}
                addedPrefix="Only in the proposal: "
                removedPrefix="Only in the page now: "
              />
            </div>
          )}
          {lines.length > collapsedLines && (
            <div className="px-3 pt-1">
              <Button
                variant="ghost"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show less" : "Show all"}
              </Button>
            </div>
          )}
          {check?.state === "applies" && check.changed && (
            <Notice status="warning">This page changed since the proposal was made.</Notice>
          )}
          {check?.state === "no_longer_applies" && (
            <Notice status="warning">
              {withReason("This change no longer applies", check.reason)}
            </Notice>
          )}
          {failure && (
            <Notice status="error">
              {withReason("This change could not be written", failure)}
            </Notice>
          )}
          <div className="flex flex-wrap gap-2 px-3 py-2">
            <Button
              variant={primary ? "primary" : "secondary"}
              disabled={!applies}
              onClick={onAccept}
            >
              Accept
            </Button>
            <Button variant="ghost" onClick={onReject}>
              Reject
            </Button>
          </div>
        </>
      )}
    </article>
  );
}

/** A state shown with its icon and text. */
function Mark({ icon, colour, text }: { icon: IconName; colour: string; text: string }) {
  return (
    <span className="ui-small inline-flex items-center gap-1 text-text">
      <span className={`flex ${colour}`}>
        <Icon name={icon} />
      </span>
      {text}
    </span>
  );
}

/** An accepted set: how many changes it holds, and Undo while its change can be undone. */
function SetRow({ set, onUndo }: { set: AcceptedSet; onUndo: () => void }) {
  const textId = useId();
  const text = `Accepted ${set.count} ${set.count === 1 ? "change" : "changes"}`;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
      // Without Undo, the row itself takes focus after the accept.
      {...(set.undo ? {} : { "data-set": set.id, tabIndex: -1 })}
    >
      <span id={textId}>
        <Mark icon="check_circle" colour="text-success" text={text} />
      </span>
      {set.undo && (
        <Button variant="secondary" data-set={set.id} aria-describedby={textId} onClick={onUndo}>
          Undo
        </Button>
      )}
    </div>
  );
}

/** The kinds of a batch's proposals, in the form "9 new pages, 2 edits". */
function summaryOf(proposals: Proposal[]) {
  const count = (kind: ProposalKind) =>
    proposals.filter((proposal) => proposal.kind === kind).length;
  const newPages = count("new_page");
  const edits = count("edit");
  return [
    newPages > 0 && `${newPages} ${newPages === 1 ? "new page" : "new pages"}`,
    edits > 0 && `${edits} ${edits === 1 ? "edit" : "edits"}`,
  ]
    .filter(Boolean)
    .join(", ");
}

const pageName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** `text`, then `reason`, as one sentence. */
function withReason(text: string, reason: string) {
  return /[.!?]$/.test(reason) ? `${text}: ${reason}` : `${text}: ${reason}.`;
}
