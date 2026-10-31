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
