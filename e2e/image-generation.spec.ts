import { expect, type Locator, type Page, test } from "@playwright/test";

// The browser preview's assistant (src/lib/preview-fixtures.ts) answers a message asking for an
// image, portrait, picture or scene with one image request, generated at once with a sample image
// and without any network: a portrait of Brother Ketil (120 × 160) or, for anything else, the Glass
// Steppe (1200 × 300). Without a saved image provider, the request is not generated. Each test
// loads the preview afresh, so its world starts as the sample world.

const pane = (page: Page) => page.getByRole("complementary", { name: "Assistant" });
const card = (page: Page, name: string) =>
  pane(page).getByRole("article", { name: `Image: ${name}` });
const toast = (page: Page) => page.getByRole("status").getByRole("listitem");

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element has no box.");
  return found;
}

/**
 * Opens the sample world at `width` in `colorScheme`, opens the pane where it starts closed, and
 * saves a text provider and, with `imageProvider`, an image provider.
 */
async function openWithProviders(
  page: Page,
  { width = 1280, colorScheme = "dark", imageProvider = true } = {},
) {
  await page.emulateMedia({ colorScheme: colorScheme as "dark" | "light" });
  await page.setViewportSize({ width, height: width === 720 ? 480 : 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("button", { name: "Assistant" })).toBeVisible();
  if (!(await pane(page).isVisible()))
    await page.getByRole("button", { name: "Assistant" }).click();
  await pane(page).getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const text = settings.getByRole("group", { name: "Text provider" });
  await text.getByLabel("Base URL").fill("https://api.mistral.ai/v1");
  await text.getByLabel("Model").fill("mistral-small-latest");
  await text.getByRole("button", { name: "Save" }).click();
  // The saved settings arrive before the image group is filled, so they cannot replace its draft.
  await expect(pane(page).getByText("mistral-small-latest")).toBeAttached();
  if (imageProvider) await saveImageProvider(page);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

async function saveImageProvider(page: Page) {
  const image = page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("group", { name: "Image provider" });
  await image.getByLabel("Model").fill("google/gemini-2.5-flash-image");
  await image.getByLabel("API key").fill("sk-or-preview");
  await image.getByRole("button", { name: "Save" }).click();
  await expect(image.getByText(/Sent only to openrouter\.ai\./)).toBeVisible();
}

/** Sends `text` and waits until the answer has ended. */
async function send(page: Page, text: string) {
  const message = pane(page).getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
}

/** The image's natural and drawn widths, once it has loaded. */
async function widths(image: Locator) {
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  return image.evaluate((element: HTMLImageElement) => ({
    natural: element.naturalWidth,
    drawn: element.getBoundingClientRect().width,
  }));
}

for (const width of [1280, 1024, 720]) {
  for (const colorScheme of ["dark", "light"]) {
    test(`a portrait is shown, viewed large, approved and undone from the toast at ${width}px in ${colorScheme} mode`, async ({
      page,
    }) => {
      await openWithProviders(page, { width, colorScheme });

      await send(page, "Draw a portrait of Brother Ketil");

      const portrait = card(page, "Brother Ketil");
      await expect(portrait).toContainText("Pending");
      const thumbnail = portrait.getByRole("button", { name: "Brother Ketil" });
      const shown = await widths(thumbnail.getByRole("img"));
      expect(shown.drawn).toBe(shown.natural);
      // The pane holds one accent-filled control, the card's Approve, and nothing overflows it.
      await expect(pane(page).locator("button.bg-accent")).toHaveCount(1);
      await expect(portrait.getByRole("button", { name: "Approve" })).toHaveClass(/bg-accent/);
      const inPane = await box(pane(page));
      const card_ = await box(portrait);
      expect(card_.x + card_.width).toBeLessThanOrEqual(inPane.x + inPane.width);
      await portrait.getByRole("button", { name: "Prompt" }).click();
      await expect(portrait).toContainText("Ink and watercolour portrait.");

      // By pointer, then by keyboard; Escape and Close return focus to the thumbnail.
      await thumbnail.click();
      const lightbox = page.getByRole("dialog", { name: "Brother Ketil" });
      await expect(lightbox.getByRole("button", { name: "Close" })).toBeFocused();
      const large = await widths(lightbox.getByRole("img", { name: "Brother Ketil" }));
      expect(large.drawn).toBe(large.natural);
      await expect(lightbox.locator("button.bg-accent")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(lightbox).toHaveCount(0);
      await expect(thumbnail).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(lightbox.getByRole("button", { name: "Close" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(lightbox).toHaveCount(0);
      await expect(thumbnail).toBeFocused();

      await portrait.getByRole("button", { name: "Approve" }).click();

      await expect(toast(page)).toContainText("Image saved as images/Brother Ketil.png");
      await expect(portrait).toContainText("Saved as images/Brother Ketil.png");
      await expect(portrait.getByRole("button", { name: "Undo" })).toBeFocused();
      await expect(pane(page).locator("button.bg-accent")).toHaveCount(0);
      if (width === 1280) {
        await expect(page.getByRole("treeitem", { name: "images", exact: true })).toBeVisible();
      }
      await toast(page).getByRole("button", { name: "Undo" }).click();
      // Below 1280px the pane is an overlay, which a press outside it closes.
      if (width < 1280) await page.getByRole("button", { name: "Assistant" }).click();
      await expect(portrait).toContainText("Undone; it can be approved again");
      await expect(portrait.getByRole("button", { name: "Approve" })).toBeVisible();
      if (width === 1280) {
        await expect(page.getByRole("treeitem", { name: "images", exact: true })).toHaveCount(0);
      }
    });
  }
}

test("a landscape fits the window in the lightbox, is regenerated with a change, and the earlier one rejected", async ({
  page,
}) => {
  await openWithProviders(page, { width: 720 });

  await send(page, "Show me a picture of the steppe at night");
  const earlier = card(page, "The Glass Steppe");
  await earlier.getByRole("button", { name: "The Glass Steppe" }).click();
  const lightbox = page.getByRole("dialog", { name: "The Glass Steppe" });
  const fitted = await widths(lightbox.getByRole("img"));
  expect(fitted.drawn).toBeLessThan(fitted.natural);
  expect(fitted.drawn).toBeLessThanOrEqual(720 - 2 * 16);

  // Regenerate in the lightbox closes it and opens the change box on the card.
  await lightbox.getByRole("button", { name: "Regenerate" }).click();
  await expect(lightbox).toHaveCount(0);
  const change = earlier.getByRole("textbox", { name: "Change" });
  await expect(change).toBeFocused();
  await change.fill("Add a sandstorm on the horizon");
  await change.press("Enter");
  await expect(pane(page).getByRole("textbox", { name: "Message" })).toBeFocused();
  await expect(pane(page).getByText("Regenerates the image “The Glass Steppe”")).toBeVisible();
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();

  const cards = pane(page).getByRole("article", { name: "Image: The Glass Steppe" });
  await expect(cards).toHaveCount(2);
  const revised = cards.nth(1);
  await revised.getByRole("button", { name: "Prompt" }).click();
  await expect(revised).toContainText("Add a sandstorm on the horizon");
  await expect(revised).toContainText("That image was sent as a reference.");
  // Only the newest answer's first pending image has the primary Approve.
  await expect(pane(page).locator("button.bg-accent")).toHaveCount(1);
  await expect(revised.getByRole("button", { name: "Approve" })).toHaveClass(/bg-accent/);

  await cards.nth(0).getByRole("button", { name: "Reject" }).click();

  await expect(cards.nth(0)).toContainText("Rejected");
  await expect(cards.nth(0).getByRole("button")).toHaveCount(0);
  await expect(revised.getByRole("button", { name: "Approve" })).toBeVisible();
});

test("an image requested without an image provider is generated once one is saved in Settings", async ({
  page,
}) => {
  await openWithProviders(page, { imageProvider: false });

  await send(page, "Draw a portrait of Brother Ketil");

  const portrait = card(page, "Brother Ketil");
  await expect(portrait).toContainText("Add an image provider in Settings to generate images.");
  await portrait.getByRole("button", { name: "Settings" }).click();
  await saveImageProvider(page);
  await page.keyboard.press("Escape");
  await portrait.getByRole("button", { name: "Generate" }).click();

  await expect(portrait.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(portrait.getByRole("button", { name: "Brother Ketil" })).toBeVisible();
});
