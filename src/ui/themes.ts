/** The themes, in the order they are offered. Each one's values live in theme.css. */
export const themes = [
  {
    id: "saturn-seal",
    name: "Saturn Seal",
    description: "Cold greys with a pale teal light.",
  },
  {
    id: "bound",
    name: "Bound",
    description: "Bone on soot black with blackletter titles.",
  },
  {
    id: "lamplight",
    name: "Lamplight",
    description: "Night green with candle-yellow light and one serif.",
  },
] as const;

export type ThemeId = (typeof themes)[number]["id"];

/** Shows `id` at once. Saturn Seal is the root element without a `data-theme` attribute. */
export function applyTheme(id: ThemeId) {
  if (id === "saturn-seal") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}
