import type { EditorView } from "@codemirror/view";
import { type RefObject, useEffect, useRef } from "react";
import type { ImageEmbed, ImageRequest } from "@/types/api";
import { imageRequests, setImages } from "@/ui/image-embeds";
import { imagesResolve } from "../api/commands";

/** How long after the last change to a page's text its image embeds are looked at again. */
export const imageRequestDelay = 150;

/**
 * Asks the core what the image embeds of one page's editor resolve to and gives the answer to it:
 * at once when asked to, and after a change once the text has rested, only when the change
 * altered which images the page embeds. An answer applies only while no later request has
 * started, so a late one never overwrites a newer one.
 */
export class ImageRequests {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest = 0;
  /** The embeds last asked for, as one key; null when the next change must ask in any case. */
  private asked: string | null = null;

  constructor(
    private readonly path: string,
    private readonly editor: () => EditorView | null,
    private readonly ask: (
      path: string,
      embeds: ImageRequest[],
    ) => Promise<ImageEmbed[]> = imagesResolve,
  ) {}

  /** Asks again once the text has not changed for `imageRequestDelay`, if its embeds changed. */
  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const view = this.editor();
      if (view && JSON.stringify(imageRequests(view.state)) !== this.asked) this.now();
    }, imageRequestDelay);
  }

  /** Asks now, for the editor's embeds as they are, as when the page shows again. */
  now() {
    clearTimeout(this.timer);
    const view = this.editor();
    if (!view) return;
    const embeds = imageRequests(view.state);
    const key = JSON.stringify(embeds);
    this.asked = key;
    const request = ++this.latest;
    if (embeds.length === 0) return;
    this.ask(this.path, embeds).then(
      (answer) => {
        if (request !== this.latest) return;
        this.editor()?.dispatch({ effects: setImages(embeds, answer) });
      },
      // The images stay as they are; the next change asks again.
      () => {
        if (this.asked === key) this.asked = null;
      },
    );
  }

  /** Stops asking, and drops any answer still on its way. */
  dispose() {
    clearTimeout(this.timer);
    this.latest++;
  }
}

/**
 * Keeps the images of the page at `path` current in its running editor, which `view` holds while
 * the page is ready: asked for when the editor mounts, which is when its tab shows. The editor
 * reports its own changes through the returned `changed`, and a state put in it, as after a
 * reload, through `replaced`.
 */
export function usePageImages(path: string, view: RefObject<EditorView | null> | undefined) {
  const requests = useRef<ImageRequests | null>(null);

  useEffect(() => {
    if (!view) return;
    const current = new ImageRequests(path, () => view.current);
    requests.current = current;
    current.now();
    return () => {
      current.dispose();
      if (requests.current === current) requests.current = null;
    };
  }, [path, view]);

  return {
    changed: () => requests.current?.changed(),
    replaced: () => requests.current?.now(),
  };
}
