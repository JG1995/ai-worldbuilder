import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "@/lib/ipc";
import type { PageText } from "@/types/api";
import { autosaveDelay, isReadOnlyNotice, PageSaver, type SaveNotice } from "./saving";

type Write = { text: string; version: string };

/** A deferred result, so a test decides when a command answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A saver of "Page.md" read as `page`, whose writes succeed unless `write` says otherwise. */
function saverOf(
  page: PageText,
  options: {
    write?: (call: Write) => Promise<{ version: string }>;
    read?: () => Promise<PageText>;
  } = {},
) {
  const writes: Write[] = [];
  /** Each write's `keepMine` flag, in the order of `writes`. */
  const keepMines: boolean[] = [];
  const notices: (SaveNotice | null)[] = [];
  let count = 0;
  const saver = new PageSaver("Page.md", page, {
    read: options.read ?? (() => Promise.reject(new IpcError("io", "unexpected read"))),
    write: (_path, text, version, keepMine) => {
      writes.push({ text, version });
      keepMines.push(keepMine);
      return options.write?.({ text, version }) ?? Promise.resolve({ version: `v${++count}` });
    },
    notify: (notice) => notices.push(notice),
  });
  return { saver, writes, keepMines, notices, lastNotice: () => notices.at(-1) ?? null };
}

const page: PageText = { text: "# Kesh\n", version: "v0" };

/** The core's answer for a page deleted or moved on disk. */
const gone = new IpcError("not_found", "The page or folder does not exist.");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("autosave", () => {
  it("saves about a second after the last change, and not before", async () => {
    const { saver, writes } = saverOf(page);

    saver.changed("# Kesh\nA");
    await vi.advanceTimersByTimeAsync(autosaveDelay - 100);
    saver.changed("# Kesh\nAB");
    await vi.advanceTimersByTimeAsync(autosaveDelay - 1);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ text: "# Kesh\nAB", version: "v0" }]);
  });

  it("writes nothing for text equal to what was last read or saved", async () => {
    const { saver, writes } = saverOf(page);

    saver.changed("# Kesh\nA");
    saver.changed("# Kesh\n");
    await vi.advanceTimersByTimeAsync(autosaveDelay);

    expect(writes).toEqual([]);
    expect(await saver.flush()).toEqual({ kind: "clean" });
    expect(writes).toEqual([]);
  });

  it("stops for good once disposed", async () => {
    const { saver, writes } = saverOf(page);

    saver.changed("# Kesh\nA");
    saver.dispose();
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    saver.changed("# Kesh\nAB");
    await vi.advanceTimersByTimeAsync(autosaveDelay);

    expect(writes).toEqual([]);
  });

  it("reports nothing about a save that ends after it was disposed", async () => {
    const answer = deferred<{ version: string }>();
    const { saver, notices } = saverOf(page, { write: () => answer.promise });
    saver.changed("# Kesh\nA");
    const flushed = saver.flush();
    await vi.advanceTimersByTimeAsync(0);

    saver.dispose();
    answer.reject(new IpcError("io", "Another program is using the file."));
    await flushed;

    expect(notices).toEqual([]);
  });

  it("waits while held, and saves pending edits after the release", async () => {
    const { saver, writes } = saverOf(page);

    saver.changed("# Kesh\nA");
    saver.hold();
    await vi.advanceTimersByTimeAsync(autosaveDelay * 2);
    expect(writes).toEqual([]);

    saver.release();
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    expect(writes).toEqual([{ text: "# Kesh\nA", version: "v0" }]);
  });
});

describe("flushing", () => {
  it("saves at once, and records the text it sent, not the editor's later text", async () => {
    const answer = deferred<{ version: string }>();
    const { saver, writes } = saverOf(page, { write: () => answer.promise });

    saver.changed("# Kesh\nA");
    const flushed = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.changed("# Kesh\nAB");
    answer.resolve({ version: "v1" });

    expect(await flushed).toEqual({ kind: "saved" });
    expect(writes).toEqual([{ text: "# Kesh\nA", version: "v0" }]);

    // The later edit is still unsaved, so the next flush sends it with the new version.
    expect(await saver.flush()).toEqual({ kind: "saved" });
    expect(writes.at(-1)).toEqual({ text: "# Kesh\nAB", version: "v1" });
  });

  it("runs one save at a time: an edit during a save is saved after it", async () => {
    const first = deferred<{ version: string }>();
    let calls = 0;
    const { saver, writes } = saverOf(page, {
      write: () => (++calls === 1 ? first.promise : Promise.resolve({ version: "v2" })),
    });

    saver.changed("# Kesh\nA");
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    saver.changed("# Kesh\nAB");
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    // The second save waits for the first, which has not answered.
    expect(writes).toHaveLength(1);

    first.resolve({ version: "v1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([
      { text: "# Kesh\nA", version: "v0" },
      { text: "# Kesh\nAB", version: "v1" },
    ]);
  });
});

describe("failed saves", () => {
  it("shows the reason, keeps the text, and tries again on the next edit", async () => {
    let fail = true;
    const { saver, writes, lastNotice } = saverOf(page, {
      write: () =>
        fail
          ? Promise.reject(new IpcError("io", "Another program is using the file."))
          : Promise.resolve({ version: "v1" }),
    });

    saver.changed("# Kesh\nA");
    expect(await saver.flush()).toEqual({
      kind: "failed",
      reason: "Another program is using the file.",
    });
    expect(lastNotice()).toEqual({ kind: "failed", reason: "Another program is using the file." });

    fail = false;
    saver.changed("# Kesh\nAB");
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    expect(writes.at(-1)).toEqual({ text: "# Kesh\nAB", version: "v0" });
    expect(lastNotice()).toBeNull();
  });

  it("reports a page deleted on disk as missing, with the missing-page notice", async () => {
    const { saver, writes, lastNotice } = saverOf(page, { write: () => Promise.reject(gone) });

    saver.changed("# Kesh\nA");

    expect(await saver.flush()).toEqual({ kind: "missing" });
    expect(lastNotice()).toEqual({ kind: "missing" });
    saver.changed("# Kesh\nAB");
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    expect(writes).toHaveLength(1);
  });
});

describe("restoring a missing page", () => {
  async function missingPage() {
    const parts = saverOf(page, { write: () => Promise.reject(gone) });
    parts.saver.changed("# Kesh\nmine");
    await parts.saver.flush();
    return parts;
  }

  it("writes the editor's text back and saves as usual afterwards", async () => {
    const { saver, writes, lastNotice } = await missingPage();
    const restores: string[] = [];

    const restored = await saver.restore((_path, text) => {
      restores.push(text);
      return Promise.resolve({ version: "restored" });
    });

    expect(restored).toBe(true);
    expect(restores).toEqual(["# Kesh\nmine"]);
    expect(lastNotice()).toBeNull();
    expect(await saver.flush()).toEqual({ kind: "clean" });
    expect(writes).toHaveLength(1);
  });

  it("shows the conflict notice when something is back at the page's path", async () => {
    const { saver, lastNotice } = await missingPage();

    const restored = await saver.restore(() =>
      Promise.reject(new IpcError("conflict", "Something is at the page's path again.")),
    );

    expect(restored).toBe(false);
    expect(lastNotice()).toEqual({ kind: "conflict" });
  });
});

describe("outside changes", () => {
  const theirs: PageText = { text: "# Kesh\ntheirs\n", version: "theirs" };

  /** A saver whose reads answer `read`, and the texts it reloaded into the editor. */
  function outside(
    read: () => Promise<PageText>,
    write?: (call: Write) => Promise<{ version: string }>,
  ) {
    const parts = saverOf(page, { read, write });
    const reloads: string[] = [];
    const check = () =>
      parts.saver.outsideChange((text) => {
        reloads.push(text);
        return true;
      });
    return { ...parts, reloads, check };
  }

  it("reload a page without unsaved edits, which then has nothing to save", async () => {
    const { saver, writes, reloads, check } = outside(() => Promise.resolve(theirs));

    expect(await check()).toEqual({ kind: "reloaded" });

    expect(reloads).toEqual([theirs.text]);
    expect(await saver.flush()).toEqual({ kind: "clean" });
    saver.changed("# Kesh\ntheirs\nmine");
    await saver.flush();
    expect(writes).toEqual([{ text: "# Kesh\ntheirs\nmine", version: "theirs" }]);
  });

  it("ignore a page whose version equals the one last read or saved", async () => {
    const { reloads, lastNotice, check } = outside(() => Promise.resolve(page));

    expect(await check()).toEqual({ kind: "unchanged" });

    expect(reloads).toEqual([]);
    expect(lastNotice()).toBeNull();
  });

  it("show the conflict notice on a page with unsaved edits, which pauses autosave", async () => {
    const { saver, writes, reloads, lastNotice, check } = outside(() => Promise.resolve(theirs));
    saver.changed("# Kesh\nmine");

    expect(await check()).toEqual({ kind: "notice" });

    expect(reloads).toEqual([]);
    expect(lastNotice()).toEqual({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(autosaveDelay * 2);
    expect(writes).toEqual([]);
  });

  it("read the page only after a save in flight has settled", async () => {
    const answer = deferred<{ version: string }>();
    const reads: string[] = [];
    const { saver, reloads, check } = outside(
      () => {
        reads.push("read");
        return Promise.resolve({ text: "# Kesh\nA", version: "v1" });
      },
      () => answer.promise,
    );
    saver.changed("# Kesh\nA");
    const saving = saver.flush();
    await vi.advanceTimersByTimeAsync(0);

    const checking = check();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual([]);

    answer.resolve({ version: "v1" });
    await saving;
    // The change it was told of is its own save, whose version it now holds.
    expect(await checking).toEqual({ kind: "unchanged" });
    expect(reads).toEqual(["read"]);
    expect(reloads).toEqual([]);
  });

  it("show the conflict notice, not a reload, when typing happens while the page is read", async () => {
    const read = deferred<PageText>();
    let reading = false;
    const { saver, reloads, lastNotice, check } = outside(() => {
      reading = true;
      return read.promise;
    });

    const checking = check();
    await vi.advanceTimersByTimeAsync(0);
    expect(reading).toBe(true);
    saver.changed("# Kesh\ntyped meanwhile");
    read.resolve(theirs);

    expect(await checking).toEqual({ kind: "notice" });
    expect(reloads).toEqual([]);
    expect(lastNotice()).toEqual({ kind: "conflict" });
  });

  it("show the missing-page notice for a page deleted on disk", async () => {
    const { saver, lastNotice, check } = outside(() => Promise.reject(gone));

    expect(await check()).toEqual({ kind: "notice" });

    expect(lastNotice()).toEqual({ kind: "missing" });
    expect(await saver.flush()).toEqual({ kind: "missing" });
  });

  it("clear the missing-page notice when the page comes back as it was saved", async () => {
    let read = () => Promise.reject<PageText>(gone);
    const { saver, writes, reloads, lastNotice, check } = outside(() => read());
    saver.changed("# Kesh\nmine");
    expect(await check()).toEqual({ kind: "notice" });
    expect(lastNotice()).toEqual({ kind: "missing" });

    read = () => Promise.resolve(page);
    expect(await check()).toEqual({ kind: "unchanged" });

    expect(lastNotice()).toBeNull();
    expect(reloads).toEqual([]);
    // Autosave resumes for the unsaved text.
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    expect(writes).toEqual([{ text: "# Kesh\nmine", version: "v0" }]);
  });

  it("keep unsaved text read-only under the notice of a page that is no longer UTF-8", async () => {
    const notUtf8 = new IpcError("not_utf8", "The page is not UTF-8 text.");
    const edited = outside(() => Promise.reject(notUtf8));
    const unedited = outside(() => Promise.reject(notUtf8));
    edited.saver.changed("# Kesh\nmine");

    expect(await edited.check()).toEqual({ kind: "notice" });
    expect(await unedited.check()).toEqual({ kind: "unreadable", error: notUtf8 });

    expect(edited.lastNotice()).toEqual({
      kind: "not_utf8",
      message: "The page is not UTF-8 text.",
    });
    expect(isReadOnlyNotice(edited.lastNotice())).toBe(true);
    expect(await edited.saver.flush()).toEqual({
      kind: "failed",
      reason: "The page is not UTF-8 text.",
    });
    expect(edited.writes).toEqual([]);
    expect(unedited.lastNotice()).toBeNull();
  });
});

describe("conflicts", () => {
  const changedOnDisk = () => Promise.reject(new IpcError("conflict", "The page changed on disk."));

  it("pause autosave and flushing until resolved", async () => {
    const { saver, writes, lastNotice } = saverOf(page, { write: changedOnDisk });
    saver.changed("# Kesh\nmine");
    expect(await saver.flush()).toEqual({ kind: "conflict" });
    expect(lastNotice()).toEqual({ kind: "conflict" });

    saver.changed("# Kesh\nmine, more");
    await vi.advanceTimersByTimeAsync(autosaveDelay * 2);

    expect(await saver.flush()).toEqual({ kind: "conflict" });
    expect(writes).toHaveLength(1);
  });

  it("resolve with Keep mine, which writes the editor's text over the current version", async () => {
    let calls = 0;
    const { saver, writes, keepMines, lastNotice } = saverOf(page, {
      write: () => (++calls === 1 ? changedOnDisk() : Promise.resolve({ version: "v2" })),
      read: () => Promise.resolve({ text: "# Kesh\ntheirs\n", version: "theirs" }),
    });
    saver.changed("# Kesh\nmine");
    await saver.flush();

    await saver.keepMine();

    expect(writes.at(-1)).toEqual({ text: "# Kesh\nmine", version: "theirs" });
    expect(lastNotice()).toBeNull();
    // Autosave works again.
    saver.changed("# Kesh\nmine again");
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    expect(writes.at(-1)).toEqual({ text: "# Kesh\nmine again", version: "v2" });
    // Only Keep mine's write says so, not the flush before it or the autosave after it.
    expect(keepMines).toEqual([false, true, false]);
  });

  it("resolve with Load theirs, which gives the current text to the editor and writes nothing", async () => {
    const { saver, writes, lastNotice } = saverOf(page, {
      write: changedOnDisk,
      read: () => Promise.resolve({ text: "# Kesh\ntheirs\n", version: "theirs" }),
    });
    saver.changed("# Kesh\nmine");
    await saver.flush();
    const replaced: string[] = [];

    await saver.loadTheirs((text) => {
      replaced.push(text);
      return true;
    });

    expect(replaced).toEqual(["# Kesh\ntheirs\n"]);
    expect(lastNotice()).toBeNull();
    expect(await saver.flush()).toEqual({ kind: "clean" });
    expect(writes).toHaveLength(1);
  });

  it("stay when Load theirs cannot put the text in the editor", async () => {
    const { saver, lastNotice } = saverOf(page, {
      write: changedOnDisk,
      read: () => Promise.resolve({ text: "# Kesh\ntheirs\n", version: "theirs" }),
    });
    saver.changed("# Kesh\nmine");
    await saver.flush();

    await saver.loadTheirs(() => false);

    expect(lastNotice()).toEqual({ kind: "conflict" });
  });

  it("show why the page cannot be read when Keep mine finds it so, and write nothing", async () => {
    const notUtf8 = "The page is not UTF-8 text, so it cannot be edited here.";
    const { saver, writes, lastNotice } = saverOf(page, {
      write: changedOnDisk,
      read: () => Promise.reject(new IpcError("not_utf8", notUtf8)),
    });
    saver.changed("# Kesh\nmine");
    await saver.flush();

    await saver.keepMine();

    expect(lastNotice()).toEqual({ kind: "not_utf8", message: notUtf8 });
    saver.changed("# Kesh\nmine");
    await vi.advanceTimersByTimeAsync(autosaveDelay);
    expect(await saver.flush()).toEqual({ kind: "failed", reason: notUtf8 });
    expect(writes).toHaveLength(1);
  });
});
