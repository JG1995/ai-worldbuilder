import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, whose images are
// Characters/Brother Ketil.png (120 × 160), Maps/The Glass Steppe.png (1200 × 300) and
// Maps/Torn map.png, which no browser can decode.
const worldName = "The Glass Steppe";

const embeds = [
  "![[Brother Ketil.png]]",
  "![[The Glass Steppe.png]]",
  "![[Brother Ketil.png|60]]",
  "![Ketil small|60x40](Characters/Brother%20Ketil.png)",
  "![[gone.png]]",
  "![[Torn map.png]]",
  "![[.obsidian/hidden.png]]",
  "![web](https://example.com/a.png)",
  "![web](//example.com/b.png)",
  "![data](data:image/png;base64,AAAA)",
  "The end.",
];

const editor = (page: Page) => page.getByRole("textbox", { name: "Pictures" });
const images = (page: Page) => editor(page).locator(".cm-image img");
const placeholders = (page: Page) => editor(page).locator(".cm-image-placeholder");

/** Opens the sample world and creates a page of `embeds`, with the cursor on its last line. */
async function openPictures(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
  await page
    .getByRole("complementary", { name: "File tree" })
    .getByRole("button", { name: "New page" })
    .click();
  await page.keyboard.type("Pictures");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText(embeds.join("\n\n"));
}

/** Each drawn image's text alternative and size, once it has loaded. */
async function shownImages(page: Page) {
  await expect
    .poll(() =>
      images(page).evaluateAll((all) =>
        (all as HTMLImageElement[]).every((image) => image.complete),
      ),
    )
    .toBe(true);
  return images(page).evaluateAll((all) =>
    (all as HTMLImageElement[]).map((image) => ({
      alt: image.alt,
      loaded: image.naturalWidth > 0,
      width: Math.round(image.getBoundingClientRect().width),
      height: Math.round(image.getBoundingClientRect().height),
    })),
  );
}

const columnWidth = (page: Page) =>
  editor(page).evaluate((content) => Math.round(content.getBoundingClientRect().width));

test("See an embedded image: images show in both views at their sizes, within the column, and the rest as placeholders", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await openPictures(page);

  await expect(images(page)).toHaveCount(4);
  const column = await columnWidth(page);
  const editing = await shownImages(page);
  expect(editing).toEqual([
    { alt: "Brother Ketil", loaded: true, width: 120, height: 160 },
    { alt: "The Glass Steppe", loaded: true, width: column, height: Math.round(column / 4) },
    { alt: "Brother Ketil", loaded: true, width: 60, height: 80 },
    { alt: "Ketil small", loaded: true, width: 30, height: 40 },
  ]);
  expect(column).toBeLessThan(1200);
  // Each after its icon's glyph.
  await expect(placeholders(page)).toHaveText([
    /^.gone\.png was not found\.$/u,
    /^.Torn map\.png cannot be shown\.$/u,
    /^.hidden\.png is not in this world\.$/u,
    /^.Web images are not loaded: https:\/\/example\.com\/a\.png$/u,
    /^.Web images are not loaded: \/\/example\.com\/b\.png$/u,
    /^.Web images are not loaded: data:image\/png;base64,AAAA$/u,
  ]);

  // On the cursor's line the embed shows as typed, with its image below the line.
  await editor(page).locator(".cm-line").first().click();
  const line = editor(page).locator(".cm-line").first();
  await expect(line).toHaveText("![[Brother Ketil.png]]");
  await expect(line.locator("xpath=following-sibling::*[1]")).toHaveClass("cm-image");
  await expect(images(page)).toHaveCount(4);

  await page.keyboard.press("ControlOrMeta+e");
  const reading = page.getByRole("region", { name: "Pictures", exact: true });
  await expect(reading).toBeFocused();
  await expect(images(page)).toHaveCount(4);
  const readingColumn = await columnWidth(page);
  const shown = await shownImages(page);
  expect(shown.map(({ width }) => width)).toEqual([120, readingColumn, 60, 30]);
  await expect(placeholders(page)).toHaveCount(6);

  // Only the preview's own origin is ever asked, for the web images too.
  const origin = new URL(page.url()).origin;
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});

test("under forced colours, image placeholders keep their border", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openPictures(page);

  const placeholder = placeholders(page).first();
  await expect(placeholder).toHaveCSS("border-top-style", "dashed");
  await expect(placeholder).toHaveCSS("border-top-width", "1px");
});
