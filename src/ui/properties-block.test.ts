import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { Properties } from "@/types/api";
import { createPageState, MarkdownEditor } from "./MarkdownEditor";
import { frontmatterText, propertiesNeeded, setProperties } from "./properties-block";

const page = "---\ntitle: Kesh Tor\nkin: [Ada, Bren]\n---\n# Kesh Tor\n";

/** The reading view of `text`; this file is plain TypeScript, so without JSX. */
function renderReading(text = page) {
  render(
    createElement(MarkdownEditor, {
      state: createPageState(text, "Kesh Tor", 0, { preview: true }),
      readOnly: false,
      reading: true,
    }),
  );
  const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Kesh Tor" }));
  if (!view) throw new Error("No editor");
  return view;
}

/** Gives the editor the core's `properties` of its frontmatter. */
function read(view: EditorView, properties: Properties) {
  act(() => view.dispatch({ effects: setProperties(frontmatterText(view.state.doc), properties) }));
}

const heading = () => screen.getByRole("button", { name: "Properties" });

describe("the properties block", () => {
  it("shows each kind of value as the design says, collapsed until its heading is pressed", () => {
    const view = renderReading();
    read(view, {
      state: "rows",
      rows: [
        { key: "title", value: { kind: "text", text: "Kesh Tor" } },
        { key: "kin", value: { kind: "list", items: ["Ada", "Bren"] } },
        { key: "home", value: { kind: "yaml", text: "town: Saltmere\nstreet: Dock Row" } },
        { key: "notes", value: { kind: "empty" } },
      ],
    });
    const list = view.contentDOM.querySelector("dl");
    if (!(list instanceof HTMLElement)) throw new Error("No list");

    expect(heading()).toHaveAttribute("aria-expanded", "false");
    expect(list).not.toBeVisible();
    const pressed = heading();
    fireEvent.click(pressed);

    expect(heading()).toBe(pressed);
    expect(heading()).toHaveAttribute("aria-expanded", "true");
    expect(list).toBeVisible();
    const terms = [...list.querySelectorAll("dt")].map((term) => term.textContent);
    const values = [...list.querySelectorAll("dd")];
    expect(terms).toEqual(["title", "kin", "home", "notes"]);
    expect(values.map((value) => value.textContent)).toEqual([
      "Kesh Tor",
      "Ada, Bren",
      "town: Saltmere\nstreet: Dock Row",
      "",
    ]);
    expect(values[2]).toHaveClass("cm-properties-yaml");
    // Pressing changes nothing in the text or its history.
    expect(view.state.doc.toString()).toBe(page);
    fireEvent.click(heading());
    expect(list).not.toBeVisible();
  });

  it("shows unreadable frontmatter as typed, and none for no properties", () => {
    const view = renderReading();
    read(view, { state: "source" });
    fireEvent.click(heading());

    expect(within(view.contentDOM).getByText(/title: Kesh Tor/).tagName).toBe("PRE");
    expect(view.contentDOM.querySelector("pre")).toHaveTextContent(
      /^title: Kesh Tor kin: \[Ada, Bren\]$/,
    );

    read(view, { state: "none" });
    expect(screen.queryByRole("button", { name: "Properties" })).toBeNull();
    expect(view.contentDOM).not.toHaveTextContent("title");
  });

  it("hides the frontmatter until the core read it, and asks again for new frontmatter", () => {
    const view = renderReading();

    expect(view.contentDOM).not.toHaveTextContent("title");
    expect(propertiesNeeded(view.state)).toBe(frontmatterText(view.state.doc));
    read(view, { state: "none" });
    expect(propertiesNeeded(view.state)).toBeNull();
    act(() => view.dispatch({ changes: { from: 4, insert: "age: 41\n" } }));
    expect(propertiesNeeded(view.state)).toBe(
      "---\nage: 41\ntitle: Kesh Tor\nkin: [Ada, Bren]\n---",
    );
  });

  it("shows property text as text, never as HTML", () => {
    const view = renderReading();
    read(view, {
      state: "rows",
      rows: [{ key: "<i>key</i>", value: { kind: "text", text: "<b>bold</b><img src=x>" } }],
    });

    const list = view.contentDOM.querySelector("dl");
    expect(list?.querySelector("b, i, img")).toBeNull();
    expect(list).toHaveTextContent("<i>key</i><b>bold</b><img src=x>");
  });
});
