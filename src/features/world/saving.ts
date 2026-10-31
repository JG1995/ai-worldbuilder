import type { IpcError } from "../../lib/ipc";
import type { PageText } from "./commands";

/** How long typing must pause before a page saves by itself. */
export const autosaveDelay = 1000;

/** The outcome of saving a page now. */
export type SaveResult =
  | { kind: "saved" }
  /** Nothing needed saving. */
  | { kind: "clean" }
  | { kind: "failed"; reason: string }
  | { kind: "conflict" }
  | { kind: "missing" };

/**
 * What a page shows about saving, above its editor. `failed` and `conflict` keep the text
 * editable; the others say why the page cannot be read any more, and its text stays read-only.
 */
export type SaveNotice =
  | { kind: "failed"; reason: string }
  | { kind: "conflict" }
  | { kind: "missing" }
  | { kind: "not_utf8"; message: string }
  | { kind: "unreadable"; message: string };

/** Whether a notice leaves the page's text read-only, because nothing may be written to it. */
export function isReadOnlyNotice(notice: SaveNotice | null) {
  return notice !== null && notice.kind !== "failed" && notice.kind !== "conflict";
}

/** Until the missing-page notice exists, a page deleted on disk fails to save with this reason. */
export const missingReason = "The page no longer exists on disk.";

/** What the saver needs from outside: the core's commands and a place to show its notice. */
export type SaverPorts = {
  read: (path: string) => Promise<PageText>;
  write: (path: string, text: string, version: string) => Promise<{ version: string }>;
  notify: (notice: SaveNotice | null) => void;
};

/** An editor document; CodeMirror's `Text` and plain strings both qualify. */
type Document = { toString(): string };

/**
 * Saves one open page: about a second after its last change, or at once on `flush`. One save runs
 * at a time, and each sends the text it captured when it started, so an edit made during a save
 * is saved by the next one. It never writes while the page is in conflict or read-only.
 */
export class PageSaver {
  private saved: PageText;
  private latest: Document;
  private notice: SaveNotice | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private held = false;
  private disposed = false;

  constructor(
    private readonly path: string,
    page: PageText,
    private readonly ports: SaverPorts,
  ) {
    this.saved = page;
    this.latest = page.text;
  }

  /** Records the editor's new document and restarts the autosave delay. */
  changed(document: Document) {
    this.latest = document;
    this.schedule();
  }

  /** Saves the latest text now, after any save already running. */
  flush(): Promise<SaveResult> {
    this.cancelTimer();
    return this.enqueue(() => this.save());
  }

  /** Resolves a conflict by writing the editor's text over the page as it is on disk now. */
  keepMine(): Promise<void> {
    return this.enqueue(async () => {
      if (this.notice?.kind !== "conflict") return;
      const current = await this.readCurrent();
      if (!current) return;
      this.saved = current;
      this.setNotice(null);
      await this.save();
    });
  }

  /**
   * Resolves a conflict by reading the page as it is on disk now and giving its text to
   * `replace`, which puts it in the editor and returns false when it cannot.
   */
  loadTheirs(replace: (text: string) => boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.notice?.kind !== "conflict") return;
      const current = await this.readCurrent();
      if (!current || !replace(current.text)) return;
      this.saved = current;
      this.latest = current.text;
      this.setNotice(null);
    });
  }

  /** Stops autosave until `release`, while the world may be changing. */
  hold() {
    this.held = true;
    this.cancelTimer();
  }

  release() {
    this.held = false;
    if (this.latest.toString() !== this.saved.text) this.schedule();
  }

  /** Stops this saver for good: the page closed or its world is gone. */
  dispose() {
    this.disposed = true;
    this.cancelTimer();
  }

  private schedule() {
    this.cancelTimer();
    if (this.disposed || this.held) return;
    // A save in conflict or on a read-only page writes nothing, so it needs no guard here.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.save());
    }, autosaveDelay);
  }

  private cancelTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async save(): Promise<SaveResult> {
    const notice = this.notice;
    if (this.disposed) return { kind: "clean" };
    if (notice?.kind === "conflict") return { kind: "conflict" };
    if (notice?.kind === "missing") return { kind: "missing" };
    if (notice?.kind === "not_utf8" || notice?.kind === "unreadable") {
      return { kind: "failed", reason: notice.message };
    }
    const text = this.latest.toString();
    if (text === this.saved.text) {
      this.setNotice(null);
      return { kind: "clean" };
    }
    try {
      const { version } = await this.ports.write(this.path, text, this.saved.version);
      this.saved = { text, version };
      this.setNotice(null);
      return { kind: "saved" };
    } catch (error) {
      const { kind, message } = error as IpcError;
      if (kind === "conflict") {
        this.cancelTimer();
        this.setNotice({ kind: "conflict" });
        return { kind: "conflict" };
      }
      const reason = kind === "not_found" ? missingReason : message;
      this.setNotice({ kind: "failed", reason });
      return kind === "not_found" ? { kind: "missing" } : { kind: "failed", reason };
    }
  }

  /** The page as it is on disk, or null after showing why it cannot be read. */
  private async readCurrent(): Promise<PageText | null> {
    try {
      return await this.ports.read(this.path);
    } catch (error) {
      const { kind, message } = error as IpcError;
      this.cancelTimer();
      if (kind === "not_found") this.setNotice({ kind: "missing" });
      else if (kind === "not_utf8") this.setNotice({ kind: "not_utf8", message });
      else this.setNotice({ kind: "unreadable", message });
      return null;
    }
  }

  private setNotice(notice: SaveNotice | null) {
    // A stopped saver's page is gone, and a page opened at its path since has a saver of its own.
    if (this.disposed || (notice === null && this.notice === null)) return;
    this.notice = notice;
    this.ports.notify(notice);
  }
}
