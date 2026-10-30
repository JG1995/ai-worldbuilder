import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button, type ButtonVariant, IconButton } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Menu, MenuButton, type MenuItem } from "../ui/Menu";
import { Notice } from "../ui/Notice";
import { TextInput } from "../ui/TextInput";
import { type Toast, ToastRegion } from "../ui/Toast";
import { type Point, Tooltip } from "../ui/Tooltip";

// Every name, label and message here is sample data. The build guard in vite.config.ts keeps this
// module out of production builds.

const buttonLabels: { variant: ButtonVariant; label: string }[] = [
  { variant: "primary", label: "Open world…" },
  { variant: "secondary", label: "New world…" },
  { variant: "ghost", label: "New page" },
  { variant: "destructive", label: 'Delete "Saltmere"' },
];

const pageActions: MenuItem[] = [
  { id: "open", label: "Open in new tab", shortcut: "Ctrl+Enter" },
  { id: "rename", label: "Rename", shortcut: "F2" },
  { id: "duplicate", label: "Duplicate", disabled: true },
  { id: "reveal", label: "Reveal in file manager" },
  { id: "delete", label: "Delete", shortcut: "Delete", destructive: true },
];

const worldActions: MenuItem[] = [
  { id: "new-page", label: "New page", shortcut: "Ctrl+N" },
  { id: "new-folder", label: "New folder" },
  { id: "close", label: "Close world" },
];

const toastMessages = [
  'Saved "Saltmere"',
  "Reloaded: changed outside Grimoire.md",
  'Moved "Tide charts of the drowned archive" to Archive',
  "Accepted 7 changes",
];

function Section({ title, use, children }: { title: string; use: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-divider border-t py-8">
      <div>
        <h2 className="label-caps text-text">{title}</h2>
        <p className="ui text-text-muted">{use}</p>
      </div>
      {children}
    </section>
  );
}

/** One region of a demo. Each region holds at most one primary button. */
function Region({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border border-divider p-4">
      <h3 className="ui-small text-text-muted">{title}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function ButtonsSection() {
  return (
    <Section title="Buttons" use="Variants and states. Hover and press them to see those states.">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
        <Region title="Default">
          {buttonLabels.map(({ variant, label }) => (
            <Button key={variant} variant={variant}>
              {label}
            </Button>
          ))}
        </Region>
        <Region title="Disabled">
          {buttonLabels.map(({ variant, label }) => (
            <Button key={variant} variant={variant} disabled>
              {label}
            </Button>
          ))}
        </Region>
        <Region title="Loading: the label's width is kept">
          {buttonLabels.map(({ variant, label }) => (
            <Button key={variant} variant={variant} loading>
              {label}
            </Button>
          ))}
        </Region>
        <Region title="Long and short labels">
          <Button variant="secondary">Keep mine</Button>
          <Button variant="destructive">Delete "Ærøskøbing and the drowned archive"</Button>
        </Region>
        <Region title="Icon buttons, with tooltips">
          <IconButton icon="close" label="Close tab" shortcut="Ctrl+W" />
          <IconButton icon="note_add" label="New page" shortcut="Ctrl+N" />
          <IconButton icon="create_new_folder" label="New folder" />
          <IconButton icon="menu" label="Show file tree" />
          <IconButton icon="more_horiz" label="More actions" disabled />
        </Region>
      </div>
    </Section>
  );
}

function InputsSection() {
  return (
    <Section title="Inputs" use="Text inputs at the regular and compact sizes.">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
        <TextInput label="World name" defaultValue="Saltmere" />
        <TextInput label="Search pages" placeholder="Type a page name" />
        <TextInput
          label="Page name"
          defaultValue="Saltmere"
          error='A page named "Saltmere" already exists.'
        />
        <div className="flex flex-col gap-1">
          <span className="ui text-text">Compact, as in a tree rename</span>
          <TextInput label="Rename page" hideLabel size="compact" defaultValue="Ærøskøbing" />
        </div>
      </div>
    </Section>
  );
}

function TooltipSection() {
  return (
    <Section title="Tooltip" use="Hover or focus a control. Tooltips stay inside the window.">
      <div className="flex items-center justify-between gap-4">
        <Tooltip text="Export the world as a folder of Markdown files" shortcut="Ctrl+E">
          {(describedBy) => (
            <Button variant="secondary" aria-describedby={describedBy}>
              Export…
            </Button>
          )}
        </Tooltip>
        <IconButton icon="info" label="About this sample world" />
      </div>
    </Section>
  );
}

function MenuSection() {
  const [contextMenu, setContextMenu] = useState<Point | Element | null>(null);
  const [chosen, setChosen] = useState("nothing yet");

  return (
    <Section title="Menu" use="A context menu and a menu button. Arrow keys, Home and End move.">
      <div className="flex flex-wrap items-center gap-6">
        <button
          type="button"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              setContextMenu(event.currentTarget);
            }
          }}
          className="ui flex h-control-compact w-64 items-center gap-2 px-2 text-text transition-colors hover:bg-hover"
        >
          <span className="text-text-muted">
            <Icon name="description" />
          </span>
          Saltmere
        </button>
        <MenuButton
          icon="more_horiz"
          label="World actions"
          items={worldActions}
          onSelect={setChosen}
        />
      </div>
      <p className="ui text-text-muted">
        Right-click the row, or focus it and press Shift+F10. Chosen: {chosen}
      </p>
      {contextMenu && (
        <Menu
          label="Page actions"
          items={pageActions}
          at={contextMenu}
          onSelect={setChosen}
          onClose={() => setContextMenu(null)}
        />
      )}
    </Section>
  );
}

type PushToast = (toast: { message?: string; action?: string }) => void;

function DialogSection({ pushToast }: { pushToast: PushToast }) {
  const [open, setOpen] = useState<"delete" | "new-page" | null>(null);
  const [nameError, setNameError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const formId = useId();

  function close() {
    setOpen(null);
    setNameError(undefined);
  }

  function createPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    if (!name) {
      setNameError("Enter a name for the page.");
      return;
    }
    close();
    pushToast({ message: `Created "${name}"`, action: "Open" });
  }

  return (
    <Section title="Dialog" use="Modal dialogs. Tab stays inside, and Escape cancels.">
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setOpen("delete")}>
          Delete page…
        </Button>
        <Button variant="secondary" onClick={() => setOpen("new-page")}>
          New page…
        </Button>
      </div>
      {open === "delete" && (
        <Dialog
          title='Delete "Saltmere"?'
          initialFocus={cancel}
          onCancel={close}
          actions={
            <>
              <Button ref={cancel} variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  close();
                  pushToast({ message: 'Deleted "Saltmere"', action: "Undo" });
                }}
              >
                Delete "Saltmere"
              </Button>
            </>
          }
        >
          The page moves to the system trash. Links to it become unresolved.
        </Dialog>
      )}
      {open === "new-page" && (
        <Dialog
          title="New page"
          onCancel={close}
          actions={
            <>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" form={formId}>
                Create page
              </Button>
            </>
          }
        >
          <form id={formId} onSubmit={createPage}>
            <TextInput label="Name" name="name" error={nameError} />
          </form>
        </Dialog>
      )}
    </Section>
  );
}

function ToastsSection({ pushToast, lastAction }: { pushToast: PushToast; lastAction?: string }) {
  return (
    <Section
      title="Toasts"
      use="Toasts close after 6 seconds; hover or focus pauses them. A fourth closes the oldest."
    >
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => pushToast({})}>
          Push a toast
        </Button>
        <Button variant="secondary" onClick={() => pushToast({ action: "Undo" })}>
          Push a toast with Undo
        </Button>
      </div>
      <p className="ui text-text-muted">Last toast action: {lastAction ?? "none yet"}</p>
    </Section>
  );
}

function NoticesSection() {
  return (
    <Section title="Notices" use="Inline notices stay until their cause is resolved.">
      <div className="flex flex-col gap-3">
        <Notice
          status="warning"
          actions={
            <>
              <Button variant="secondary">Keep mine</Button>
              <Button variant="ghost">Load theirs</Button>
              <Button variant="ghost">Compare</Button>
            </>
          }
        >
          Saltmere.md changed on disk while you were editing it.
        </Notice>
        <Notice
          status="error"
          actions={
            <>
              <Button variant="secondary">Locate…</Button>
              <Button variant="ghost">Close</Button>
            </>
          }
        >
          Saltmere.md is missing on disk.
        </Notice>
        <Notice status="info">Indexing world…</Notice>
        <Notice status="success" actions={<Button variant="ghost">Open folder</Button>}>
          Exported 42 pages.
        </Notice>
      </div>
    </Section>
  );
}

/** The controls sections. Their demos keep local state only. */
export function ControlsSections() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastAction, setLastAction] = useState<string>();
  const count = useRef(0);

  const pushToast: PushToast = ({ message, action }) => {
    const index = count.current++;
    const text = message ?? toastMessages[index % toastMessages.length];
    setToasts((current) => [...current, { id: String(index), message: text, action }]);
  };

  return (
    <>
      <ButtonsSection />
      <InputsSection />
      <TooltipSection />
      <MenuSection />
      <DialogSection pushToast={pushToast} />
      <ToastsSection pushToast={pushToast} lastAction={lastAction} />
      <NoticesSection />
      <ToastRegion
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
        onAction={(id) => {
          setLastAction(toasts.find((toast) => toast.id === id)?.action);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }}
        className="fixed bottom-4 left-4"
      />
    </>
  );
}
