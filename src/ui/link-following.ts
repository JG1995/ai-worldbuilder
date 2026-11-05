import { EditorView } from "@codemirror/view";
import type { EditorLink } from "@/types/api";
import { editorLinks, linkAt } from "./editor-links";
import { focusableLinkStarts, isReading } from "./live-preview";
import { gridPosition, linkStart } from "./table-grid";
import { type WebLink, webLinkAt, webLinksShown } from "./web-links";

/** What following a link does, which `MarkdownEditor` gives from its `onFollow` and `onOpenWeb`. */
export type LinkFollowers = {
  /** Follows `link`, if there is one, and says whether it did. */
  follow: (link: EditorLink | null) => boolean;
  /** Opens `link`, if there is one, and says whether it did. */
  open: (link: WebLink | null) => boolean;
};

/**
 * Whether a mouse down asks to follow a link: the primary button with Ctrl or Cmd alone, or in the
 * reading view with neither too.
 */
function isFollowClick(event: MouseEvent, reading: boolean) {
  const plain = !event.ctrlKey && !event.metaKey;
  return (
    event.button === 0 &&
    (event.ctrlKey !== event.metaKey || (reading && plain)) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Whether a key press asks to follow a link: Alt/Option+Enter alone, or Enter in the reading view. */
function isFollowKey(event: KeyboardEvent, reading: boolean) {
  return (
    event.key === "Enter" &&
    (event.altKey || reading) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** The focusable link element of the reading view that `target` is in, in `editor`'s text. */
function linkElement(editor: EditorView, target: EventTarget | null) {
  const element = target instanceof Element ? target.closest("[data-link]") : null;
  return element && editor.contentDOM.contains(element) ? element : null;
}

/**
 * Focuses the first of the reading view's focusable links that start at `starts`, in order, first
 * scrolling one into view when CodeMirror has not drawn it, which it does then by the next measure.
 * A start with no link drawn even then gives way to the next one.
 */
function focusLink(editor: EditorView, starts: readonly number[]) {
  const [from, ...rest] = starts;
  if (from === undefined) return;
  const drawn = () =>
    [...editor.contentDOM.querySelectorAll<HTMLElement>("[data-link]")].find(
      (element) => linkStart(editor, element) === from,
    );
  const element = drawn();
  if (element) {
    element.focus();
    return;
  }
  editor.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  editor.requestMeasure({
    read: () => null,
    write: () => {
      const found = drawn();
      if (found) found.focus();
      else focusLink(editor, rest);
    },
  });
}

/**
 * Follows the links of `editor`'s text on the gestures that ask to, as `MarkdownEditor`'s
 * `onFollow` describes them, and moves Tab between the reading view's focusable links, listening on
 * `container`, the element around the editor. Returns the function that stops listening.
 */
export function followLinks(
  editor: EditorView,
  container: HTMLElement,
  { follow, open }: LinkFollowers,
) {
  /** The web link at `position`, while web links are shown. */
  const webAt = (position: number | null) =>
    position !== null && editor.state.facet(webLinksShown)
      ? webLinkAt(editor.state, position)
      : null;
  /** Follows the wiki link at `position`, or opens the web link there, and says whether it did. */
  const followAt = (position: number | null) =>
    follow(position === null ? null : linkAt(editor.state, position)) || open(webAt(position));
  // The reading view follows only the resolved wiki links and the web links it draws as
  // focusable, by where they start.
  const followReading = (target: EventTarget | null) => {
    const element = linkElement(editor, target);
    const start = element && linkStart(editor, element);
    const links = editor.state.field(editorLinks, false)?.links ?? [];
    const link = links.find((link) => link.from === start);
    return follow(link?.state === "resolved" ? link : null) || open(webAt(start));
  };
  // In the capture phase, before CodeMirror's own handlers, which leave alone an event whose
  // default is prevented: a click that follows a link does not also move the cursor.
  const followClick = (event: MouseEvent) => {
    const reading = isReading(editor.state);
    // A press on a tooltip, such as a link's preview, is not on the text below it.
    const onText = event.target instanceof Node && editor.contentDOM.contains(event.target);
    if (!onText || !isFollowClick(event, reading)) return;
    const followed = reading
      ? followReading(event.target)
      : followAt(
          gridPosition(editor, event) ?? editor.posAtCoords({ x: event.clientX, y: event.clientY }),
        );
    if (followed) event.preventDefault();
  };
  const followKey = (event: KeyboardEvent) => {
    const reading = isReading(editor.state);
    if (!isFollowKey(event, reading)) return;
    const followed = reading
      ? followReading(event.target)
      : followAt(editor.state.selection.main.head);
    if (followed) event.preventDefault();
  };
  // Tab and Shift+Tab from a focusable link of the reading view go to the next or the previous
  // one in the text, also one CodeMirror has not drawn; past the last or the first, they go on as
  // they would.
  const tabLink = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const element = isReading(editor.state) ? linkElement(editor, event.target) : null;
    const from = element && linkStart(editor, element);
    if (from === null) return;
    const starts = focusableLinkStarts(editor.state);
    const next = event.shiftKey
      ? starts.filter((start) => start < from).reverse()
      : starts.filter((start) => start > from);
    if (next.length === 0) return;
    event.preventDefault();
    focusLink(editor, next);
  };
  container.addEventListener("mousedown", followClick, true);
  container.addEventListener("keydown", followKey, true);
  container.addEventListener("keydown", tabLink, true);
  return () => {
    container.removeEventListener("mousedown", followClick, true);
    container.removeEventListener("keydown", followKey, true);
    container.removeEventListener("keydown", tabLink, true);
  };
}
