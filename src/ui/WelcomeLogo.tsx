import lamplightDark from "@/assets/brand/lamplight-wordmark-dark.svg";
import lamplightLight from "@/assets/brand/lamplight-wordmark-light.svg";
import saturnSealDark from "@/assets/brand/lockup-stacked-dark.svg";
import saturnSealLight from "@/assets/brand/lockup-stacked-light.svg";

// Saturn Seal's stacked lockup is drawn 120px tall with one wordmark cap height of clear space on
// every side; the kit master's viewBox is 442.487 units tall and its cap height is 100 units.
// Lamplight's wordmark files include their clear space, so they are drawn 100px tall as they are.
const saturnSeal = { height: 120, padding: (120 * 100) / 442.487 };
const lamplight = { height: 100 };

/**
 * The welcome screen's logo: the active theme's logo for the current mode. Every theme's images
 * are rendered, and theme.css displays only the active one, so this component never reads the
 * theme.
 */
export function WelcomeLogo() {
  return (
    <>
      <img
        src={saturnSealDark}
        alt="Grimoire.md"
        data-welcome-logo="saturn-seal-dark"
        className="box-content"
        style={saturnSeal}
      />
      <img
        src={saturnSealLight}
        alt="Grimoire.md"
        data-welcome-logo="saturn-seal-light"
        className="box-content"
        style={saturnSeal}
      />
      <img
        src={lamplightDark}
        alt="Grimoire.md"
        data-welcome-logo="lamplight-dark"
        style={lamplight}
      />
      <img
        src={lamplightLight}
        alt="Grimoire.md"
        data-welcome-logo="lamplight-light"
        style={lamplight}
      />
    </>
  );
}
