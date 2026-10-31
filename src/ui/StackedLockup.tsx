import darkLockup from "@/assets/brand/lockup-stacked-dark.svg";
import lightLockup from "@/assets/brand/lockup-stacked-light.svg";

// The kit master's viewBox is 442.487 units tall, and its wordmark cap height is 100 units.
const CAP_HEIGHT_RATIO = 100 / 442.487;

/**
 * The stacked lockup: the colour version in dark mode and the one-colour version in light mode,
 * with clear space of one wordmark cap height on every side. `height` is the artwork's height in
 * pixels; it is never drawn smaller than 24px.
 */
export function StackedLockup({ height }: { height: number }) {
  return (
    <span className="inline-block" style={{ padding: height * CAP_HEIGHT_RATIO }}>
      <img
        src={darkLockup}
        alt="Grimoire.md"
        className="block min-h-6 light:hidden"
        style={{ height }}
      />
      <img
        src={lightLockup}
        alt="Grimoire.md"
        className="hidden min-h-6 light:block"
        style={{ height }}
      />
    </span>
  );
}
