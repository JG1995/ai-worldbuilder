import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ImageEmbed, ImageRequest } from "@/types/api";
import { imageEmbeds } from "@/ui/image-embeds";
import { createPageState } from "@/ui/MarkdownEditor";
import { ImageRequests, imageRequestDelay, usePageImages } from "./images";

vi.mock("../api/commands", () => ({ imagesResolve: vi.fn() }));
const { imagesResolve } = await import("../api/commands");

const text = "The port: ![[harbour.png]]\n";
const harbour: ImageRequest = { target: "harbour.png", form: "wiki" };
const found = (stamp: string): ImageEmbed => ({ state: "found", path: "Maps/harbour.png", stamp });

/** A core whose answers arrive when the test gives them, in any order. */
function slowCore() {
  const answers: ((answer: ImageEmbed[]) => void)[] = [];
  const ask = vi.fn(
    (_path: string, _embeds: ImageRequest[]) =>
      new Promise<ImageEmbed[]>((resolve) => {
        answers.push(resolve);
      }),
  );
  return { ask, answers };
}

let view: EditorView;
const shownSources = () =>
  [...view.contentDOM.querySelectorAll(".cm-image img")].map((image) => image.getAttribute("src"));

beforeEach(() => {
  vi.useFakeTimers();
  const state = createPageState(text, "Kesh Tor", text.length, { preview: true });
  view = new EditorView({
    state: state.update({
      effects: StateEffect.appendConfig.of(
        imageEmbeds((path, stamp) => `test-image://${path}?v=${stamp}`),
      ),
    }).state,
    parent: document.body,
  });
});

afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

it("asks for the page's embeds at once, and draws a new URL when an image's stamp changed", async () => {
  const ask = vi
    .fn()
    .mockResolvedValueOnce([found("1")])
    .mockResolvedValueOnce([found("2")]);
  const requests = new ImageRequests("Kesh Tor.md", () => view, ask);

  requests.now();
  await vi.advanceTimersByTimeAsync(0);
  expect(ask.mock.calls).toEqual([["Kesh Tor.md", [harbour]]]);
  expect(shownSources()).toEqual(["test-image://Maps/harbour.png?v=1"]);

  requests.now();
  await vi.advanceTimersByTimeAsync(0);
  expect(shownSources()).toEqual(["test-image://Maps/harbour.png?v=2"]);
});

it("asks after a change only once typing pauses, and only when the embedded images changed", async () => {
  const ask = vi.fn(async (_path: string, embeds: ImageRequest[]) => embeds.map(() => found("1")));
  const requests = new ImageRequests("Kesh Tor.md", () => view, ask);
  requests.now();
  await vi.advanceTimersByTimeAsync(0);

  view.dispatch({ changes: { from: 0, insert: "Busy " } });
  requests.changed();
  await vi.advanceTimersByTimeAsync(imageRequestDelay);
  expect(ask).toHaveBeenCalledOnce();

  view.dispatch({ changes: { from: view.state.doc.length, insert: "![[gate.png]]" } });
  requests.changed();
  await vi.advanceTimersByTimeAsync(imageRequestDelay - 1);
  requests.changed();
  await vi.advanceTimersByTimeAsync(imageRequestDelay - 1);
  expect(ask).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);

  expect(ask).toHaveBeenLastCalledWith("Kesh Tor.md", [
    harbour,
    { target: "gate.png", form: "wiki" },
  ]);
});

it("drops an answer that a later request overtook, and every answer once disposed", async () => {
  const { ask, answers } = slowCore();
  const requests = new ImageRequests("Kesh Tor.md", () => view, ask);

  requests.now();
  requests.now();
  answers[1]([found("latest")]);
  answers[0]([found("overtaken")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(shownSources()).toEqual(["test-image://Maps/harbour.png?v=latest"]);

  requests.now();
  requests.dispose();
  answers[2]([found("late")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(shownSources()).toEqual(["test-image://Maps/harbour.png?v=latest"]);
});

it("asks when the page shows and after a state was put in its editor, as after a reload", async () => {
  vi.mocked(imagesResolve).mockResolvedValue([found("1")]);
  const ref = { current: view };

  const shown = renderHook(() => usePageImages("Kesh Tor.md", ref));
  expect(imagesResolve).toHaveBeenCalledTimes(1);
  shown.result.current.replaced();
  expect(imagesResolve).toHaveBeenCalledTimes(2);
  shown.unmount();

  // Its tab is shown again.
  renderHook(() => usePageImages("Kesh Tor.md", ref)).unmount();
  expect(imagesResolve).toHaveBeenCalledTimes(3);
});
