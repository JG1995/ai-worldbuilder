import { useEffect, useId, useRef, useState } from "react";
import type { ImageReview, ImageState, NotGenerated } from "@/types/api";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { Lightbox } from "./Lightbox";
import { Notice } from "./Notice";

type ImageCardProps = {
  image: ImageReview;
  /** Where its stored bytes load from, while it has them. */
  url: string;
  /** Its Approve is the pane's one primary button. */
  primary: boolean;
  /** An answer is running, so the change box cannot send. */
  running: boolean;
  /** Why its generation failed, as a sentence, when it failed in this opening. */
  failureText: string | null;
  /** Why its last approval could not be written. */
  approveFailure: string | null;
  /** Approves it; resolves with whether it was approved. */
  onApprove: () => Promise<boolean>;
  /** Sends `change` as a message that regenerates it. */
  onRegenerate: (change: string) => void;
  /** Rejects it and moves focus on. */
  onReject: () => void;
  /** Starts generating it; resolves with whether it started. */
  onGenerate: () => Promise<boolean>;
  onCancel: () => void;
  onCopyEmbed: () => void;
  /** Undoes its approval; resolves with whether it was undone. */
  onUndo: () => Promise<boolean>;
  onOpenSettings: () => void;
  onFocusComposer: () => void;
};

/** What takes focus once the card shows the result of an action. */
type FocusTarget = "approved" | "pending" | "generating" | "change" | "regenerate";

const notGeneratedTexts: Record<Exclude<NotGenerated, "failed">, string> = {
  stopped: "The answer was stopped, so this image was not generated.",
  answer_failed: "The answer failed, so this image was not generated.",
  over_limit: "Only four images are generated for one answer.",
  cancelled: "The generation was cancelled. The provider may still charge for it.",
  interrupted:
    "The generation was interrupted before the image arrived. The provider may still charge for it.",
  no_provider: "Add an image provider in Settings to generate images.",
};

const stateTexts: Record<Exclude<ImageState, "approved" | "rejected">, string> = {
  generating: "Generating",
  pending: "Pending",
  not_generated: "Not generated",
};

/**
 * One image request of an answer, in its state: a working line and Cancel while it is generated;
 * the thumbnail, which opens the lightbox, with Approve, Regenerate and Reject while it is pending;
 * why it was not generated, with Generate; the saved path with Copy embed and Undo once approved;
 * and only its header once rejected. Every state but rejected has the prompt disclosure, which
 * shows the exact prompt and, for a regeneration, what became of the earlier image. Regenerate
 * opens a change box on the card. The name, prompt and messages show only as text.
 */
export function ImageCard({
  image,
  url,
  primary,
  running,
  failureText,
  approveFailure,
  onApprove,
  onRegenerate,
  onReject,
  onGenerate,
  onCancel,
  onCopyEmbed,
  onUndo,
  onOpenSettings,
  onFocusComposer,
}: ImageCardProps) {
  const [viewing, setViewing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const root = useRef<HTMLElement>(null);
  const { id, name, state, path } = image;
  const pending = state === "pending";

  // The target shows once the image read after the action arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new image can bring the target.
  useEffect(() => {
    const card = root.current;
    if (!focusTarget || !card) return;
    const find = (name: string) => card.querySelector<HTMLElement>(`[data-focus="${name}"]`);
    const settled = state === "pending" || state === "approved";
    const targets: Record<FocusTarget, HTMLElement | null> = {
      approved: state === "approved" ? (find("undo") ?? find("path")) : null,
      pending: pending ? find("approve") : null,
      // An image generated before its card shows Cancel takes focus itself.
      generating: state === "generating" ? find("cancel") : settled ? card : null,
      change: find("change"),
      regenerate: find("regenerate"),
    };
    const target = targets[focusTarget];
    if (!target) return;
    target.focus();
    setFocusTarget(null);
  }, [focusTarget, image]);

  async function approve() {
    if (await onApprove()) setFocusTarget("approved");
  }

  async function undo() {
    if (await onUndo()) setFocusTarget("pending");
  }

  async function generate() {
    if (await onGenerate()) setFocusTarget("generating");
  }

  function regenerate() {
    setChanging(true);
    setFocusTarget("change");
  }

  const thumbnail = (pending || state === "approved") && (
    <button
      type="button"
      onClick={() => setViewing(true)}
      className="block w-full focus-visible:-outline-offset-2"
    >
      {/* At its natural ratio, at most the card's width and short enough to keep the actions in view. */}
      <img src={url} alt={name} className="mx-auto block max-h-80 max-w-full" />
    </button>
  );

  return (
    <article
      ref={root}
      data-image={id}
      tabIndex={-1}
      aria-label={`Image: ${name}`}
      // The border shows the card in light mode, where raised is as white as page.
      className="flex flex-col overflow-hidden rounded-md border border-divider bg-raised"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className="ui-strong min-w-0 break-words text-text">{name}</span>
        <span className="ui-small text-text-muted">Image</span>
        <StateMark image={image} />
      </div>
      {state !== "rejected" && (
        <>
          {thumbnail}
          <PromptDisclosure image={image} />
          <Body
            image={image}
            failureText={failureText}
            approveFailure={approveFailure}
            onOpenSettings={onOpenSettings}
          />
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            {pending && (
              <>
                <Button
                  variant={primary ? "primary" : "secondary"}
                  data-focus="approve"
                  onClick={() => void approve()}
                >
                  Approve
                </Button>
                <Button variant="secondary" data-focus="regenerate" onClick={regenerate}>
                  Regenerate
                </Button>
                <Button variant="ghost" onClick={onReject}>
                  Reject
                </Button>
              </>
            )}
            {state === "generating" && (
              <Button variant="secondary" data-focus="cancel" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {state === "not_generated" && (
              <Button variant="secondary" onClick={() => void generate()}>
                Generate
              </Button>
            )}
            {state === "approved" && (
              <>
                <span
                  data-focus="path"
                  tabIndex={-1}
                  className="ui-small w-full break-words text-text"
                >
                  Saved as {path}
                </span>
                <Button variant="secondary" onClick={onCopyEmbed}>
                  Copy embed
                </Button>
                {image.undo && (
                  <Button variant="secondary" data-focus="undo" onClick={() => void undo()}>
                    Undo
                  </Button>
                )}
              </>
            )}
          </div>
          {pending && changing && (
            <ChangeBox
              running={running}
              onSend={(change) => {
                setChanging(false);
                onRegenerate(change);
                onFocusComposer();
              }}
              onCancel={() => {
                setChanging(false);
                setFocusTarget("regenerate");
              }}
            />
          )}
        </>
      )}
      {viewing && (pending || state === "approved") && (
        <Lightbox
          name={name}
          url={url}
          status={<StateMark image={image} />}
          onClose={() => setViewing(false)}
          pending={
            pending
              ? { onApprove: () => void approve(), onRegenerate: regenerate, onReject }
              : undefined
          }
        />
      )}
    </article>
  );
}

/** The image's state in the header: settled states with their icon and text. */
function StateMark({ image }: { image: ImageReview }) {
  const { state, undone, notGenerated } = image;
  if (state === "approved")
    return <Mark icon="check_circle" colour="text-success" text="Approved" />;
  if (state === "rejected") return <Mark icon="close" colour="text-text-muted" text="Rejected" />;
  if (state === "pending" && undone) {
    return <Mark icon="info" colour="text-info" text="Undone; it can be approved again" />;
  }
  const text = notGenerated === "failed" ? "Failed" : stateTexts[state];
  return <span className="ui-small text-text-muted">{text}</span>;
}

/** What the card says about its state: the working line, why it was not generated, or why its
 * approval failed. */
function Body({
  image,
  failureText,
  approveFailure,
  onOpenSettings,
}: {
  image: ImageReview;
  failureText: string | null;
  approveFailure: string | null;
  onOpenSettings: () => void;
}) {
  const { state, notGenerated, failure } = image;
  if (state === "generating") {
    return <p className="ui-small px-3 pt-2 text-text-muted">Generating the image…</p>;
  }
  if (state === "pending" && approveFailure) {
    return (
      <Notice status="error">{withReason("The image could not be saved", approveFailure)}</Notice>
    );
  }
  if (state !== "not_generated" || notGenerated === null) return null;
  if (notGenerated === "failed") {
    return (
      <Notice status={failure?.reason === "rate_limited" ? "warning" : "error"}>
        <span className="block">{failureText ?? "The generation failed."}</span>
        {failure?.providerMessage && (
          <span className="block break-words">
            The provider's message: {failure.providerMessage}
          </span>
        )}
      </Notice>
    );
  }
  return (
    <Notice
      status="info"
      actions={
        notGenerated === "no_provider" && (
          <Button variant="secondary" onClick={onOpenSettings}>
            Settings
          </Button>
        )
      }
    >
      {notGeneratedTexts[notGenerated]}
    </Notice>
  );
}

/** "Prompt", which expands to the exact prompt and, for a regeneration, the earlier image's fate. */
function PromptDisclosure({ image }: { image: ImageReview }) {
  const [open, setOpen] = useState(false);
  const promptId = useId();
  const { prompt, revisesName, reference } = image;

  return (
    <div className="ui-small px-3 pt-2 text-text-muted">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={promptId}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded-sm transition-colors hover:text-text"
      >
        <Icon name={open ? "expand_more" : "chevron_right"} />
        Prompt
      </button>
      <div id={promptId} hidden={!open} className="mt-1 flex flex-col gap-1 pl-5">
        <p className="whitespace-pre-wrap break-words text-text">{prompt}</p>
        {revisesName !== null && <p>{referenceNote(revisesName, reference)}</p>}
      </div>
    </div>
  );
}

/** What a regeneration's disclosure says about the image it revises. */
function referenceNote(name: string, reference: ImageReview["reference"]) {
  const revises = `It regenerates “${name}”.`;
  switch (reference) {
    case "sent":
      return `${revises} That image was sent as a reference.`;
    case "not_taken":
      return `${revises} That image was not sent: the image model takes no image input.`;
    case "gone":
      return `${revises} That image was not sent: it was rejected before this one was generated.`;
    case null:
      return revises;
  }
}

/**
 * The change a regeneration asks for: Enter sends it, Shift+Enter adds a line, and Escape or Cancel
 * closes the box. Send is unavailable while the text is blank or an answer is running.
 */
function ChangeBox({
  running,
  onSend,
  onCancel,
}: {
  running: boolean;
  onSend: (change: string) => void;
  onCancel: () => void;
}) {
  const [change, setChange] = useState("");
  const canSend = !running && change.trim() !== "";

  return (
    <div className="flex flex-col gap-2 border-divider border-t px-3 py-2">
      <textarea
        aria-label="Change"
        placeholder="What to change"
        data-focus="change"
        rows={2}
        value={change}
        onChange={(event) => setChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Escape closes the box, not the pane's overlay around it.
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (canSend) onSend(change);
        }}
        className="ui min-w-0 resize-none rounded-sm border border-outline bg-input px-2 py-1.5 text-text transition-colors placeholder:text-text-muted focus:border-accent"
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!canSend} onClick={() => onSend(change)}>
          Send
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
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

/** `text`, then `reason`, as one sentence. */
function withReason(text: string, reason: string) {
  return /[.!?]$/.test(reason) ? `${text}: ${reason}` : `${text}: ${reason}.`;
}
