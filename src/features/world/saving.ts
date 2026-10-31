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

/** Why a page that was deleted or moved on disk cannot be saved, as the failed-save dialog says. */
export const missingReason = "The page no longer exists on disk.";

/** What the saver needs from outside: the core's commands and a place to show its notice. */
export type SaverPorts = {
  read: (path: string) => Promise<PageText>;
  write: (path: string, text: string, version: string) => Promise<{ version: string }>;
  notify: (notice: SaveNotice | null) => void;
};

/** What checking a page after a change on disk did. */
export type OutsideChange =
  /** Nothing: the page on disk is the one the editor last read or saved, or the page closed. */
  | { kind: "unchanged" }
  /** The editor had no unsaved edits and shows the page from disk now. */
  | { kind: "reloaded" }
  /** A notice shows over the kept text: the conflict, the missing page, or why it cannot be read. */
  | { kind: "notice" }
  /** The page cannot be read any more and had no unsaved edits, so it needs no editor. */
  | { kind: "unreadable"; status: "not_utf8" | "read_error"; message: string }
  | { kind: "world_missing" };

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

  /** The editor's latest text. */
  text() {
    return this.latest.toString();
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

  /**
   * Writes the editor's text back with `restore` after the page was deleted or moved on disk, and
   * resolves to true when it did. Something back at the page's path turns the missing-page notice
   * into the conflict notice.
   */
  restore(restore: (path: string, text: string) => Promise<{ version: string }>): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.notice?.kind !== "missing") return false;
      const text = this.latest.toString();
      try {
        const { version } = await restore(this.path, text);
        this.saved = { text, version };
        this.setNotice(null);
        return true;
      } catch (error) {
        const { kind, message } = error as IpcError;
        // While the world's folder is gone, the page keeps its notice and its text.
        if (kind === "conflict") this.setNotice({ kind: "conflict" });
        else if (kind !== "world_missing") this.setNotice({ kind: "failed", reason: message });
        return false;
      }
    });
  }

  /**
   * Checks the page after the core reported that it changed on disk. It runs after any save in
   * flight, and no save starts until it ends. It decides only once the page has been read, from
   * the editor's text at that moment, so text typed meanwhile is never replaced: without unsaved
   * edits or a notice, `reload` puts the page from disk in the editor (false when it cannot);
   * otherwise the conflict notice shows and autosave pauses.
   */
  outsideChange(reload: (text: string) => boolean): Promise<OutsideChange> {
    return this.enqueue(async (): Promise<OutsideChange> => {
      if (this.disposed) return { kind: "unchanged" };
      let current: PageText;
      try {
        current = await this.ports.read(this.path);
      } catch (error) {
        return this.unreadable(error as IpcError);
      }
      if (this.disposed || current.version === this.saved.version) return { kind: "unchanged" };
      if (!this.edited() && this.notice === null) {
        if (!reload(current.text)) return { kind: "unchanged" };
        this.saved = current;
        this.latest = current.text;
        return { kind: "reloaded" };
      }
      this.cancelTimer();
      this.setNotice({ kind: "conflict" });
      return { kind: "notice" };
    });
  }

  /** What an outside change does to a page that can no longer be read. */
  private unreadable({ kind, message }: IpcError): OutsideChange {
    if (this.disposed) return { kind: "unchanged" };
    if (kind === "world_missing") return { kind: "world_missing" };
    if (kind !== "not_found" && !this.edited()) {
      return {
        kind: "unreadable",
        status: kind === "not_utf8" ? "not_utf8" : "read_error",
        message,
      };
    }
    this.cancelTimer();
    if (kind === "not_found") this.setNotice({ kind: "missing" });
    else if (kind === "not_utf8") this.setNotice({ kind: "not_utf8", message });
    else this.setNotice({ kind: "unreadable", message });
    return { kind: "notice" };
  }

  /** Whether the editor has text that is not saved. */
  private edited() {
    return this.text() !== this.saved.text;
  }

  /** Stops autosave until `release`, while the world may be changing. */
  hold() {
    this.held = true;
    this.cancelTimer();
  }

  release() {
    this.held = false;
    if (this.edited()) this.schedule();
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
      if (kind === "conflict" || kind === "not_found") {
        const result = kind === "conflict" ? "conflict" : "missing";
        this.cancelTimer();
        this.setNotice({ kind: result });
        return { kind: result };
      }
      this.setNotice({ kind: "failed", reason: message });
      return { kind: "failed", reason: message };
    }
  }

  /** The page as it is on disk, or null after showing why it cannot be read. */
  private async readCurrent(): Promise<PageText | null> {
    try {
      return await this.ports.read(this.path);
    } catch (error) {
      const { kind, message } = error as IpcError;
      this.cancelTimer();
      // While the world's folder is gone, the conflict stays as it is.
      if (kind === "world_missing") return null;
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
