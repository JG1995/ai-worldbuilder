import { glyphs } from "./icon-glyphs";

export type IconName = keyof typeof glyphs;

/**
 * A bundled Material Symbols Sharp glyph at 16px in the current text colour. It is hidden from
 * assistive technology: the surrounding control or text supplies the accessible name.
 */
export function Icon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" className="icon">
      {glyphs[name]}
    </span>
  );
}
