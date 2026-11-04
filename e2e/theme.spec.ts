import { expect, type Page, test } from "@playwright/test";

const windowDark = "rgb(9, 16, 22)";
const windowLight = "rgb(241, 243, 245)";

function bodyBackground(page: Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

// Chromium has no "no-preference" state: it reports `light` when the OS gives no preference,
// so that case cannot be told apart from light here. The desktop app handles it in
// `src-tauri/src/theme.rs`.
for (const [colorScheme, background] of [
  ["dark", windowDark],
  ["light", windowLight],
] as const) {
  test(`the welcome screen follows the OS colour mode: ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Open world…" })).toBeVisible();
    expect(await bodyBackground(page)).toBe(background);
  });
}

test("the showcase loads every bundled face from the dev server only", async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/showcase.html");
  await expect(page.getByRole("heading", { name: "Grimoire.md showcase" })).toBeVisible();

  const fonts = [
    ['500 16px "Darker Grotesque"', "A"],
    ['700 16px "Darker Grotesque"', "A"],
    ['400 16px "Hanken Grotesk"', "A"],
    ['500 16px "Hanken Grotesk"', "A"],
    ['700 16px "Hanken Grotesk"', "A"],
    ['400 16px "Newsreader Variable"', "A"],
    ['600 16px "Newsreader Variable"', "A"],
    ['400 16px "Grenze"', "A"],
    ['500 16px "Grenze"', "A"],
    ['700 16px "Grenze"', "A"],
    ['600 16px "Grenze Gotisch"', "A"],
    ['16px "Material Symbols Sharp"', "\u{e2c7}"],
  ];
  for (const [font, text] of fonts) {
    const loaded = await page.evaluate(
      async ([font, text]) => {
        const faces = await document.fonts.load(font, text);
        return faces.length > 0 && faces.every((face) => face.status === "loaded");
      },
      [font, text],
    );
    expect(loaded, font).toBe(true);
  }

  const origin = new URL(baseURL ?? "").origin;
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});

type TypeRole = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  letterSpacing?: number;
  textTransform?: string;
  fontVariationSettings?: string;
};

// The type roles in each theme document's frontmatter: sizes in px, letter spacing in em. CI
// cannot read .wiki/, so these tables are the copy the rendered roles are checked against; update
// both together. Saturn Seal's document is .wiki/DESIGN.md.
const saturnSealType = {
  "page-title": {
    fontFamily: "Darker Grotesque",
    fontSize: 40,
    fontWeight: "500",
    lineHeight: 1.1,
    letterSpacing: 0.01,
  },
  "world-name": {
    fontFamily: "Darker Grotesque",
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 1.2,
    letterSpacing: 0.16,
    textTransform: "uppercase",
  },
  "label-caps": {
    fontFamily: "Darker Grotesque",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 1.2,
    letterSpacing: 0.12,
    textTransform: "uppercase",
  },
  "heading-1": { fontFamily: "Hanken Grotesk", fontSize: 26, fontWeight: "700", lineHeight: 1.25 },
  "heading-2": { fontFamily: "Hanken Grotesk", fontSize: 21, fontWeight: "700", lineHeight: 1.3 },
  "heading-3": { fontFamily: "Hanken Grotesk", fontSize: 18, fontWeight: "700", lineHeight: 1.35 },
  "heading-4": { fontFamily: "Hanken Grotesk", fontSize: 16, fontWeight: "700", lineHeight: 1.4 },
  body: { fontFamily: "Hanken Grotesk", fontSize: 16, fontWeight: "400", lineHeight: 1.65 },
  "body-reading": {
    fontFamily: "Hanken Grotesk",
    fontSize: 18,
    fontWeight: "400",
    lineHeight: 1.6,
  },
  assistant: { fontFamily: "Hanken Grotesk", fontSize: 14, fontWeight: "400", lineHeight: 1.55 },
  ui: { fontFamily: "Hanken Grotesk", fontSize: 14, fontWeight: "400", lineHeight: 1.4 },
  "ui-strong": { fontFamily: "Hanken Grotesk", fontSize: 14, fontWeight: "500", lineHeight: 1.4 },
  "ui-small": { fontFamily: "Hanken Grotesk", fontSize: 13, fontWeight: "400", lineHeight: 1.4 },
  mono: {
    fontFamily: "ui-monospace, Cascadia Mono, SF Mono, DejaVu Sans Mono, monospace",
    fontSize: 13,
    fontWeight: "400",
    lineHeight: 1.5,
  },
} satisfies Record<string, TypeRole>;

// .wiki/DESIGN-LAMPLIGHT.md. Its Newsreader is bundled as Fontsource's "Newsreader Variable".
const lamplightType = {
  "page-title": {
    fontFamily: "Newsreader Variable",
    fontSize: 38,
    fontWeight: "500",
    fontVariationSettings: '"opsz" 72',
    lineHeight: 1.15,
    letterSpacing: -0.005,
  },
  "world-name": {
    fontFamily: "Newsreader Variable",
    fontSize: 18,
    fontWeight: "600",
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  "label-caps": {
    fontFamily: "Newsreader Variable",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 1.2,
    letterSpacing: 0.08,
    textTransform: "uppercase",
  },
  "heading-1": {
    fontFamily: "Newsreader Variable",
    fontSize: 30,
    fontWeight: "600",
    lineHeight: 1.2,
  },
  "heading-2": {
    fontFamily: "Newsreader Variable",
    fontSize: 24,
    fontWeight: "600",
    lineHeight: 1.25,
  },
  "heading-3": {
    fontFamily: "Newsreader Variable",
    fontSize: 21,
    fontWeight: "600",
    lineHeight: 1.3,
  },
  "heading-4": {
    fontFamily: "Newsreader Variable",
    fontSize: 18,
    fontWeight: "600",
    lineHeight: 1.4,
  },
  body: { fontFamily: "Newsreader Variable", fontSize: 18, fontWeight: "400", lineHeight: 1.6 },
  "body-reading": {
    fontFamily: "Newsreader Variable",
    fontSize: 20,
    fontWeight: "400",
    lineHeight: 1.55,
  },
  assistant: {
    fontFamily: "Newsreader Variable",
    fontSize: 16,
    fontWeight: "400",
    lineHeight: 1.55,
  },
  ui: { fontFamily: "Newsreader Variable", fontSize: 16, fontWeight: "400", lineHeight: 1.4 },
  "ui-strong": {
    fontFamily: "Newsreader Variable",
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 1.4,
  },
  "ui-small": {
    fontFamily: "Newsreader Variable",
    fontSize: 15,
    fontWeight: "400",
    lineHeight: 1.4,
  },
  mono: {
    fontFamily: "ui-monospace, Cascadia Mono, SF Mono, DejaVu Sans Mono, monospace",
    fontSize: 13,
    fontWeight: "400",
    lineHeight: 1.5,
  },
} satisfies Record<string, TypeRole>;

// .wiki/DESIGN-BOUND.md.
const boundType = {
  "page-title": {
    fontFamily: "Grenze Gotisch",
    fontSize: 36,
    fontWeight: "600",
    lineHeight: 1.25,
    letterSpacing: 0,
  },
  "world-name": {
    fontFamily: "Grenze Gotisch",
    fontSize: 18,
    fontWeight: "600",
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  "label-caps": {
    fontFamily: "Grenze",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 1.2,
    letterSpacing: 0.08,
    textTransform: "uppercase",
  },
  "heading-1": { fontFamily: "Grenze", fontSize: 28, fontWeight: "700", lineHeight: 1.25 },
  "heading-2": { fontFamily: "Grenze", fontSize: 23, fontWeight: "700", lineHeight: 1.3 },
  "heading-3": { fontFamily: "Grenze", fontSize: 20, fontWeight: "700", lineHeight: 1.35 },
  "heading-4": { fontFamily: "Grenze", fontSize: 18, fontWeight: "700", lineHeight: 1.4 },
  body: { fontFamily: "Grenze", fontSize: 18, fontWeight: "400", lineHeight: 1.6 },
  "body-reading": { fontFamily: "Grenze", fontSize: 20, fontWeight: "400", lineHeight: 1.55 },
  assistant: { fontFamily: "Grenze", fontSize: 16, fontWeight: "400", lineHeight: 1.55 },
  ui: { fontFamily: "Grenze", fontSize: 16, fontWeight: "400", lineHeight: 1.4 },
  "ui-strong": { fontFamily: "Grenze", fontSize: 16, fontWeight: "500", lineHeight: 1.4 },
  "ui-small": { fontFamily: "Grenze", fontSize: 15, fontWeight: "400", lineHeight: 1.4 },
  mono: {
    fontFamily: "ui-monospace, Cascadia Mono, SF Mono, DejaVu Sans Mono, monospace",
    fontSize: 13,
    fontWeight: "400",
    lineHeight: 1.5,
  },
} satisfies Record<string, TypeRole>;

const themeTypes: [string, Record<string, TypeRole>][] = [
  ["Saturn Seal", saturnSealType],
  ["Bound", boundType],
  ["Lamplight", lamplightType],
];

const families = (value: string) =>
  value.split(",").map((family) => family.trim().replace(/^"(.*)"$/, "$1"));
const px = (value: number) => `${Math.round(value * 100) / 100}px`;

for (const [theme, roles] of themeTypes) {
  test(`every type role in the showcase computes to ${theme}'s values`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/showcase.html");
    await page.getByRole("radio", { name: theme }).check();
    const typeSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Type", exact: true }),
    });

    for (const [role, expected] of Object.entries(roles)) {
      const style = await typeSection
        .locator(`li .${role}`)
        .first()
        .evaluate((element) => {
          const {
            fontFamily,
            fontSize,
            fontWeight,
            lineHeight,
            letterSpacing,
            textTransform,
            fontVariationSettings,
          } = getComputedStyle(element);
          return {
            fontFamily,
            fontSize,
            fontWeight,
            lineHeight,
            letterSpacing,
            textTransform,
            fontVariationSettings,
          };
        });
      const expectedFamilies = families(expected.fontFamily);

      expect(
        {
          ...style,
          fontFamily: families(style.fontFamily).slice(0, expectedFamilies.length),
          lineHeight: px(Number.parseFloat(style.lineHeight)),
          // Chromium reports a letter spacing of 0 as "normal", which is 0.
          letterSpacing: px(
            style.letterSpacing === "normal" ? 0 : Number.parseFloat(style.letterSpacing),
          ),
        },
        role,
      ).toEqual({
        fontFamily: expectedFamilies,
        fontSize: px(expected.fontSize),
        fontWeight: expected.fontWeight,
        lineHeight: px(expected.fontSize * expected.lineHeight),
        letterSpacing: px(expected.fontSize * (expected.letterSpacing ?? 0)),
        textTransform: expected.textTransform ?? "none",
        fontVariationSettings: expected.fontVariationSettings ?? "normal",
      });
    }
  });
}

test("the showcase link opens the showcase, whose switch sets the mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  await page.getByRole("link", { name: "Showcase" }).click();
  await expect(page).toHaveURL(/\/showcase\.html$/);

  await page.getByRole("radio", { name: "Light", exact: true }).check();
  expect(await bodyBackground(page)).toBe(windowLight);

  await page.getByRole("radio", { name: "OS", exact: true }).check();
  expect(await bodyBackground(page)).toBe(windowDark);

  await page.emulateMedia({ colorScheme: "light" });
  expect(await bodyBackground(page)).toBe(windowLight);

  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  expect(await bodyBackground(page)).toBe(windowDark);
});

test("the showcase's theme switch applies Lamplight and its wordmark in both modes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/showcase.html");
  const logo = page
    .locator("section", { has: page.getByRole("heading", { name: "Logo", exact: true }) })
    .getByRole("img", { name: "Grimoire.md" });
  await expect(logo).toHaveAttribute("src", /lockup-stacked-dark\.svg$/);

  await page.getByRole("radio", { name: "Lamplight" }).check();
  expect(await bodyBackground(page)).toBe("rgb(3, 19, 15)");
  await expect(logo).toHaveAttribute("src", /lamplight-wordmark-dark\.svg$/);

  await page.getByRole("radio", { name: "Light", exact: true }).check();
  expect(await bodyBackground(page)).toBe("rgb(240, 244, 243)");
  await expect(logo).toHaveAttribute("src", /lamplight-wordmark-light\.svg$/);

  await page.getByRole("radio", { name: "Saturn Seal" }).check();
  expect(await bodyBackground(page)).toBe(windowLight);
  await expect(logo).toHaveAttribute("src", /lockup-stacked-light\.svg$/);
});

test("the showcase's theme switch applies Bound and its wordmark on the welcome ground in both modes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/showcase.html");
  const logo = page
    .locator("section", { has: page.getByRole("heading", { name: "Logo", exact: true }) })
    .getByRole("img", { name: "Grimoire.md" });
  const welcomeGround = () =>
    logo.evaluate((element) => getComputedStyle(element.parentElement as Element).backgroundColor);

  await page.getByRole("radio", { name: "Bound" }).check();
  expect(await bodyBackground(page)).toBe("rgb(22, 13, 11)");
  await expect(logo).toHaveAttribute("src", /bound-wordmark-dark\.svg$/);
  expect(await welcomeGround()).toBe("rgb(26, 19, 17)");

  await page.getByRole("radio", { name: "Light", exact: true }).check();
  expect(await bodyBackground(page)).toBe("rgb(243, 238, 228)");
  await expect(logo).toHaveAttribute("src", /bound-wordmark-light\.svg$/);
  expect(await welcomeGround()).toBe("rgb(252, 250, 249)");
});

test("only Bound draws the title strap, 8px below the page title in both modes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/showcase.html");
  const straps = page.locator(".page-title + .title-strap");
  await expect(straps).not.toHaveCount(0);

  await page.getByRole("radio", { name: "Bound" }).check();
  for (const [mode, seal] of [
    ["Dark", "rgb(229, 113, 99)"],
    ["Light", "rgb(125, 26, 20)"],
  ] as const) {
    await page.getByRole("radio", { name: mode, exact: true }).check();
    const strap = straps.first();
    await expect(strap).toBeVisible();
    await expect(strap).toHaveCSS("background-color", seal);
    const geometry = await strap.evaluate((element) => {
      const title = (element.previousElementSibling as Element).getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        left: box.left - title.left,
        below: box.top - title.bottom,
        width: box.width,
        height: box.height,
      };
    });
    expect(geometry, mode).toEqual({ left: 0, below: 8, width: 48, height: 2 });
  }

  for (const theme of ["Saturn Seal", "Lamplight"]) {
    await page.getByRole("radio", { name: theme }).check();
    const displays = await straps.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).display),
    );
    expect(new Set(displays), theme).toEqual(new Set(["none"]));
  }
});
