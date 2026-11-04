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

// The type roles in .wiki/DESIGN.md's frontmatter: sizes in px, letter spacing in em. CI cannot
// read .wiki/, so this table is the copy the rendered roles are checked against; update both
// together.
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
} satisfies Record<
  string,
  {
    fontFamily: string;
    fontSize: number;
    fontWeight: string;
    lineHeight: number;
    letterSpacing?: number;
    textTransform?: string;
  }
>;

const families = (value: string) =>
  value.split(",").map((family) => family.trim().replace(/^"(.*)"$/, "$1"));
const px = (value: number) => `${Math.round(value * 100) / 100}px`;

test("every type role in the showcase computes to its DESIGN.md values", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/showcase.html");
  const typeSection = page.locator("section", {
    has: page.getByRole("heading", { name: "Type", exact: true }),
  });

  for (const [role, expected] of Object.entries(saturnSealType)) {
    const style = await typeSection
      .locator(`li .${role}`)
      .first()
      .evaluate((element) => {
        const { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform } =
          getComputedStyle(element);
        return { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform };
      });
    const expectedFamilies = families(expected.fontFamily);

    expect(
      {
        ...style,
        fontFamily: families(style.fontFamily).slice(0, expectedFamilies.length),
        lineHeight: px(Number.parseFloat(style.lineHeight)),
        letterSpacing:
          style.letterSpacing === "normal" ? "normal" : px(Number.parseFloat(style.letterSpacing)),
      },
      role,
    ).toEqual({
      fontFamily: expectedFamilies,
      fontSize: px(expected.fontSize),
      fontWeight: expected.fontWeight,
      lineHeight: px(expected.fontSize * expected.lineHeight),
      letterSpacing:
        "letterSpacing" in expected ? px(expected.fontSize * expected.letterSpacing) : "normal",
      textTransform: "textTransform" in expected ? expected.textTransform : "none",
    });
  }
});

test("the showcase link opens the showcase, whose switch sets the mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  await page.getByRole("link", { name: "Showcase" }).click();
  await expect(page).toHaveURL(/\/showcase\.html$/);

  await page.getByRole("radio", { name: "Light" }).check();
  expect(await bodyBackground(page)).toBe(windowLight);

  await page.getByRole("radio", { name: "OS" }).check();
  expect(await bodyBackground(page)).toBe(windowDark);

  await page.emulateMedia({ colorScheme: "light" });
  expect(await bodyBackground(page)).toBe(windowLight);

  await page.getByRole("radio", { name: "Dark" }).check();
  expect(await bodyBackground(page)).toBe(windowDark);
});
