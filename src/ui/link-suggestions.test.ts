import { type Completion, CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { LinkSuggestion, LinkSuggestions } from "@/types/api";
import {
  indexingHeading,
  linkCompletions,
  noMatchLabel,
  type Suggest,
  suggestFacet,
} from "./link-suggestions";

/** Where the cursor is in a test's text; it is not part of the text. */
const cursor = "‸";

function stateOf(written: string, suggest: Suggest) {
  const at = written.indexOf(cursor);
  const doc = written.replace(cursor, "");
  return EditorState.create({
    doc,
    selection: { anchor: at === -1 ? doc.length : at },
    extensions: [markdown(), suggestFacet.of(suggest)],
  });
}

const mirela: LinkSuggestion = { path: "Mirela.md", name: "Mirela", alias: null, insert: "Mirela" };

function answering(answer: LinkSuggestions) {
  return vi.fn<Suggest>(async () => answer);
}

/** The suggestion list for `written`, with the cursor at `‸` or at the end. */
async function complete(written: string, suggest: Suggest = answering(ready(mirela))) {
  const state = stateOf(written, suggest);
  const result = await linkCompletions(
    new CompletionContext(state, state.selection.main.head, false),
  );
  return { state, result };
}

const ready = (...items: LinkSuggestion[]): LinkSuggestions => ({ indexing: false, items });

describe("the suggestion list", () => {
  it.each([
    ["See [[", ""],
    ["See [[Mi", "Mi"],
    ["See ![[Kesh T", "Kesh T"],
    ["[[Mirela]] and [[Pla", "Pla"],
    ["See [[Mi‸]] here", "Mi"],
  ])("opens for %j and asks for %j", async (written, query) => {
    const suggest = answering(ready(mirela));

    const { result } = await complete(written, suggest);

    expect(suggest.mock.calls).toEqual([[query]]);
    expect(result?.options.map((option) => option.label)).toEqual(["Mirela"]);
  });

  it.each([
    ["in a code span", "Roll `[[Mi‸` now"],
    ["in a code block", "```\n[[Mi‸\n```"],
    ["in the frontmatter", "---\ntitle: [[Mi‸\n---\n"],
    ["after |", "[[Mirela|the"],
    ["after #", "[[Mirela#Ear"],
    ["after ]]", "[[Mirela]] and"],
    ["on a later line", "[[Mi\nthen"],
    ["with no [[", "Mirela"],
  ])("does not open %s", async (_where, written) => {
    const suggest = answering(ready(mirela));

    const { result } = await complete(written, suggest);

    expect(result).toBeNull();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("does not open when asking fails", async () => {
    const { result } = await complete(
      "[[Mi",
      vi.fn<Suggest>(async () => Promise.reject("gone")),
    );

    expect(result).toBeNull();
  });

  it("shows the folder and the alias a page matched by, under a heading while indexing", async () => {
    const captain: LinkSuggestion = {
      path: "People/Crew/Mirela.md",
      name: "Mirela",
      alias: "the captain",
      insert: "People/Crew/Mirela|the captain",
    };

    const { result } = await complete("[[capt", answering({ indexing: true, items: [captain] }));
    const plain = await complete("[[capt", answering(ready(captain)));

    expect(result?.options).toEqual([
      expect.objectContaining({
        label: "Mirela",
        detail: "People/Crew",
        alias: "the captain",
        section: indexingHeading,
      }),
    ]);
    expect(plain.result?.options[0].section).toBeUndefined();
  });
});

describe("picking a suggestion", () => {
  /** Applies the first suggestion of `answer` in an editor showing `written`. */
  async function pick(written: string, answer: LinkSuggestions) {
    const { state, result } = await complete(written, answering(answer));
    if (!result) throw new Error("The list did not open");
    const view = new EditorView({ state });
    const option = result.options[0] as Completion & {
      apply: (view: EditorView, completion: Completion, from: number, to: number) => void;
    };
    option.apply(view, option, result.from, state.selection.main.head);
    const picked = { text: view.state.doc.toString(), cursor: view.state.selection.main.head };
    view.destroy();
    return picked;
  }

  const at = (text: string, cursorAt: number) => ({ text, cursor: cursorAt });

  it.each([
    ["a unique name", "See [[Mi", "Mirela", "See [[Mirela]]"],
    ["a shared name", "See [[Salt", "Places/Saltmere", "See [[Places/Saltmere]]"],
    ["an alias", "See [[capt", "Mirela|the captain", "See [[Mirela|the captain]]"],
    ["an embed", "See ![[Mi", "Mirela", "See ![[Mirela]]"],
  ])("writes the link to %s with the cursor after it", async (_kind, written, insert, linked) => {
    const answer = ready({ ...mirela, insert });

    expect(await pick(written, answer)).toEqual(at(linked, linked.length));
  });

  it("does not write a second ]] when one follows the cursor", async () => {
    const picked = await pick("See [[Mi‸]] here", ready(mirela));

    expect(picked).toEqual(at("See [[Mirela]] here", "See [[Mirela]]".length));
  });

  it("changes nothing on the row that says no page matches", async () => {
    const { result } = await complete("See [[Zz", answering(ready()));
    expect(result?.options.map((option) => option.label)).toEqual([noMatchLabel]);

    expect(await pick("See [[Zz", ready())).toEqual(at("See [[Zz", "See [[Zz".length));
  });
});
