import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditorLink, EditorLinks } from "@/types/api";
import { editorLinks } from "@/ui/editor-links";
import { createPageState } from "@/ui/MarkdownEditor";
import { LinkRequests, linkRequestDelay } from "./links";

const text = "Ruled by [[Mirela]].";

function linkTo(target: string): EditorLink {
  return {
    from: text.indexOf("[["),
    to: text.indexOf("]]") + 2,
    state: "resolved",
    target,
    path: `${target}.md`,
    heading: null,
    block: null,
  };
}

const ready = (...links: EditorLink[]): EditorLinks => ({ state: "ready", links });

/** A core whose answers arrive when the test gives them, in any order. */
function slowCore() {
  const answers: ((answer: EditorLinks) => void)[] = [];
  const ask = vi.fn(
    (_path: string, _text: string) =>
      new Promise<EditorLinks>((resolve) => {
        answers.push(resolve);
      }),
  );
  return { ask, answers };
}

let view: EditorView;
const links = () => view.state.field(editorLinks).links;

beforeEach(() => {
  vi.useFakeTimers();
  view = new EditorView({ state: createPageState(text, "Kesh Tor") });
});

afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

it("asks for the editor's text once typing pauses for the delay, and marks the answer's links", async () => {
  const ask = vi.fn(async () => ready(linkTo("Mirela")));
  const requests = new LinkRequests("Kesh Tor.md", () => view, ask);

  requests.changed();
  await vi.advanceTimersByTimeAsync(linkRequestDelay - 1);
  requests.changed();
  await vi.advanceTimersByTimeAsync(linkRequestDelay - 1);
  expect(ask).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  expect(ask.mock.calls).toEqual([["Kesh Tor.md", text]]);
  expect(links()).toEqual([linkTo("Mirela")]);
});

it("drops an answer for text that changed since, and one that a later request overtook", async () => {
  const { ask, answers } = slowCore();
  const requests = new LinkRequests("Kesh Tor.md", () => view, ask);

  requests.now();
  view.dispatch({ changes: { from: text.length, insert: " " } });
  answers[0](ready(linkTo("Stale")));
  await vi.advanceTimersByTimeAsync(0);
  expect(links()).toEqual([]);

  requests.now();
  requests.now();
  answers[2](ready(linkTo("Latest")));
  answers[1](ready(linkTo("Overtaken")));
  await vi.advanceTimersByTimeAsync(0);
  expect(links()).toEqual([linkTo("Latest")]);
});

it("shows no links while the index is being built", async () => {
  let answer = ready(linkTo("Mirela"));
  const requests = new LinkRequests(
    "Kesh Tor.md",
    () => view,
    async () => answer,
  );
  requests.now();
  await vi.advanceTimersByTimeAsync(0);
  expect(links()).toHaveLength(1);

  answer = { state: "not_ready" };
  requests.now();
  await vi.advanceTimersByTimeAsync(0);

  expect(links()).toEqual([]);
});

it("asks nothing more and applies nothing once disposed", async () => {
  const { ask, answers } = slowCore();
  const requests = new LinkRequests("Kesh Tor.md", () => view, ask);
  requests.now();
  requests.changed();

  requests.dispose();
  answers[0](ready(linkTo("Mirela")));
  await vi.advanceTimersByTimeAsync(linkRequestDelay);

  expect(ask).toHaveBeenCalledOnce();
  expect(links()).toEqual([]);
});
