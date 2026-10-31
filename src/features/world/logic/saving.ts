import type { IpcError } from "@/lib/ipc";
import type { PageText, PageVersion, RestoredPage } from "@/types/api";

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

/**
 * What the saver needs from outside: the core's commands and a place to show its notice. A write
 * from Keep mine sets `keepMine`.
 */
export type SaverPorts = {
  read: (path: string) => Promise<PageText>;
  write: (path: string, text: string, version: string, keepMine: boolean) => Promise<PageVersion>;
  notify: (notice: SaveNotice | null) => void;
};

/** What checking a page after a change on disk did. */
export type OutsideChange =
  /**
   * Nothing to reload: the page on disk is the one the editor last read or saved, or the page
   * closed. A notice that the page could not be read clears, since it can be again.
   */
  | { kind: "unchanged" }
  /** The editor had no unsaved edits and shows the page from disk now. */
  | { kind: "reloaded" }
  /** A notice shows over the kept text: the conflict, the missing page, or why it cannot be read. */
  | { kind: "notice" }
  /** The page cannot be read any more and had no unsaved edits, so it needs no editor. */
  | { kind: "unreadable"; error: IpcError }
  | { kind: "world_missing" };

/** What a core write of the whole page, such as Restore this version or Undo, did. */
export type ReplaceResult =
  | { kind: "replaced"; page: RestoredPage }
  /** Pending edits could not be saved first, so nothing was written; the page's notice says why. */
  | { kind: "unsaved" }
  /**
   * The core refused the write, and the page and its editor are as they were. After a `conflict`,
   * `outside` is what checking the page as after an outside change did.
   */
  | { kind: "failed"; error: IpcError; outside: OutsideChange | null };

/** How a core write of the whole page puts the page's text in its editor. */
export type ReplaceEditor = {
  /** Puts the written text in the editor as one step that undo reverts. */
  replace: (text: string) => void;
  /** Puts the text on disk in the editor after an outside change, as `outsideChange` does. */
  reload: (text: string) => boolean;
};

/** An editor document; CodeMirror's `Text` and plain strings both qualify. */
type Document = { toString(): string };

/** The notice of a page that cannot be read, from the core's error. */
function readFailureNotice({ kind, message }: IpcError): SaveNotice {
  if (kind === "not_found") return { kind: "missing" };
  return kind === "not_utf8" ? { kind: "not_utf8", message } : { kind: "unreadable", message };
}

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
  private readonly savedListeners = new Set<() => void>();

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

  /** The version of the page's bytes that the editor last read or saved. */
  savedVersion = () => this.saved.version;

  /** Calls `listener` whenever `savedVersion` changes, until the returned function is called. */
  subscribe = (listener: () => void) => {
    this.savedListeners.add(listener);
    return () => {
      this.savedListeners.delete(listener);
    };
  };

  /** Records the editor's new document and restarts the autosave delay. */
  changed(document: Document) {
    this.latest = document;
    this.schedule();
  }

  /** Saves the latest text now, after any save already running. */
  flush(): Promise<SaveResult> {
    this.cancelTimer();
    return this.enqueue(() => this.save(false));
  }

  /** Resolves a conflict by writing the editor's text over the page as it is on disk now. */
  keepMine(): Promise<void> {
    return this.enqueue(async () => {
      if (this.notice?.kind !== "conflict") return;
      const current = await this.readCurrent();
      if (!current) return;
      this.adopt(current);
      this.setNotice(null);
      await this.save(true);
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
      this.adopt(current);
      this.latest = current.text;
      this.setNotice(null);
    });
  }

  /**
   * Replaces the whole page through `write`, a core write such as Restore this version or Undo,
   * which gets the version of the bytes the editor last saved. It runs in the queue, after saving
   * pending edits first, and writes nothing when they cannot be saved, so it never replaces text
   * that is not in history. The written text goes to `editor.replace` and becomes the saved text.
   * A refused write leaves the page and the editor as they are; after a `conflict`, the page is
   * checked as after an outside change.
   */
  replacePage(
    write: (version: string) => Promise<RestoredPage>,
    editor: ReplaceEditor,
  ): Promise<ReplaceResult> {
    return this.enqueue(async (): Promise<ReplaceResult> => {
      const saved = await this.save(false);
      if (this.disposed || (saved.kind !== "saved" && saved.kind !== "clean")) {
        return { kind: "unsaved" };
      }
      const text = this.text();
      let page: RestoredPage;
      try {
        page = await write(this.saved.version);
      } catch (error) {
        const failure = error as IpcError;
        const outside = failure.kind === "conflict" ? await this.check(editor.reload) : null;
        return { kind: "failed", error: failure, outside };
      }
      this.adopt({ text: page.text, version: page.version });
      if (this.text() === text) {
        editor.replace(page.text);
        this.latest = page.text;
      } else {
        // Text typed while the page was written is kept: it now differs from the page on disk.
        this.cancelTimer();
        this.setNotice({ kind: "conflict" });
      }
      return { kind: "replaced", page };
    });
  }

  /**
   * Writes the editor's text back with `restore` after the page was deleted or moved on disk, and
   * resolves to true when it did. Something back at the page's path turns the missing-page notice
   * into the conflict notice.
   */
  restore(restore: (path: string, text: string) => Promise<PageVersion>): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.notice?.kind !== "missing") return false;
      const text = this.latest.toString();
      try {
        const { version } = await restore(this.path, text);
        this.adopt({ text, version });
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
    return this.enqueue(() => this.check(reload));
  }

  /** `outsideChange`'s check, for a task already in the queue. */
  private async check(reload: (text: string) => boolean): Promise<OutsideChange> {
    if (this.disposed) return { kind: "unchanged" };
    let current: PageText;
    try {
      current = await this.ports.read(this.path);
    } catch (error) {
      return this.unreadable(error as IpcError);
    }
    if (this.disposed) return { kind: "unchanged" };
    if (current.version === this.saved.version) {
      // A page that came back as it was saved, after a notice that it could not be read, is
      // editable again, and its unsaved text saves as usual.
      if (isReadOnlyNotice(this.notice)) {
        this.setNotice(null);
        if (this.edited()) this.schedule();
      }
      return { kind: "unchanged" };
    }
    if (!this.edited() && this.notice === null) {
      if (!reload(current.text)) return { kind: "unchanged" };
      this.adopt(current);
      this.latest = current.text;
      return { kind: "reloaded" };
    }
    this.cancelTimer();
    this.setNotice({ kind: "conflict" });
    return { kind: "notice" };
  }

  /** What an outside change does to a page that can no longer be read. */
  private unreadable(error: IpcError): OutsideChange {
    if (this.disposed) return { kind: "unchanged" };
    if (error.kind === "world_missing") return { kind: "world_missing" };
    if (error.kind !== "not_found" && !this.edited()) return { kind: "unreadable", error };
    this.cancelTimer();
    this.setNotice(readFailureNotice(error));
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
      void this.enqueue(() => this.save(false));
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

  /** Saves the latest text; `keepMine` is set when Keep mine writes it over the page on disk. */
  private async save(keepMine: boolean): Promise<SaveResult> {
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
      const { version } = await this.ports.write(this.path, text, this.saved.version, keepMine);
      this.adopt({ text, version });
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
      const failure = error as IpcError;
      this.cancelTimer();
      // While the world's folder is gone, the conflict stays as it is.
      if (failure.kind !== "world_missing") this.setNotice(readFailureNotice(failure));
      return null;
    }
  }

  /** Takes `page` as the text and version last read or saved, and tells the listeners. */
  private adopt(page: PageText) {
    const changed = page.version !== this.saved.version;
    this.saved = page;
    if (changed) for (const listener of this.savedListeners) listener();
  }

  private setNotice(notice: SaveNotice | null) {
    // A stopped saver's page is gone, and a page opened at its path since has a saver of its own.
    if (this.disposed || (notice === null && this.notice === null)) return;
    this.notice = notice;
    this.ports.notify(notice);
  }
}
