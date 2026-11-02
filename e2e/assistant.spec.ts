import { expect, type Locator, type Page, test } from "@playwright/test";

// The browser preview's settings in src/lib/preview-fixtures.ts start with AI on and no provider,
// and its sample world opens with the assistant's side pane open at its default width.

const pane = (page: Page) => page.getByRole("complementary", { name: "Assistant" });
const button = (page: Page) => page.getByRole("button", { name: "Assistant" });

async function openSampleWorld(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: "The Glass Steppe" })).toBeVisible();
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element has no box.");
  return found;
}

test("the button and Ctrl+Shift+A close and open the side pane, and opening focuses it", async ({
  page,
}) => {
  await openSampleWorld(page);
  await expect(pane(page)).toBeVisible();
  await expect(pane(page)).toContainText("Assistant");
  const main = await box(page.getByRole("main"));
  const side = await box(pane(page));
  expect(side.width).toBe(360);
  expect(side.x).toBe(main.x + main.width);

  await button(page).click();
  await expect(pane(page)).toBeHidden();
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  await button(page).click();
  await expect(pane(page)).toBeVisible();
  // Without a provider, the notice's Settings button is the pane's first control.
  await expect(pane(page).getByRole("button", { name: "Settings" })).toBeFocused();

  await page.keyboard.press("Control+Shift+A");
  await expect(pane(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Control+Shift+A");
  await expect(pane(page)).toBeVisible();
  await expect(pane(page).getByRole("button", { name: "Settings" })).toBeFocused();
});

test("the pane's edge resizes it by keyboard within 300px to 560px", async ({ page }) => {
  await openSampleWorld(page);
  const separator = page.getByRole("separator", { name: "Assistant width" });

  await separator.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "376");
  expect((await box(pane(page))).width).toBe(376);
  for (let step = 0; step < 20; step++) await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  expect((await box(pane(page))).width).toBe(300);
});

test("F6 cycles the tree, the page column and the pane", async ({ page }) => {
  await openSampleWorld(page);
  const settings = pane(page).getByRole("button", { name: "Settings" });

  await page.getByRole("treeitem").first().focus();
  await page.keyboard.press("F6");
  // Focus is in the page column, outside both panes.
  await expect(page.locator(":focus")).toHaveCount(1);
  await expect(page.locator("aside :focus")).toHaveCount(0);
  await page.keyboard.press("F6");
  await expect(settings).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.getByRole("treeitem").first()).toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(settings).toBeFocused();
});

test("at 1024px the pane opens as an overlay over the page, which Escape closes", async ({
  page,
}) => {
  await openSampleWorld(page, 1024);
  await expect(pane(page)).toBeHidden();

  await button(page).click();
  await expect(pane(page)).toBeVisible();
  // Measure once the slide has ended.
  await expect
    .poll(() => pane(page).evaluate((element) => getComputedStyle(element).translate))
    .toBe("none");
  const overlay = await box(pane(page));
  expect(overlay.x + overlay.width).toBe(1024);
  // It covers the page region instead of narrowing it.
  expect((await box(page.getByRole("main"))).width).toBe(1024 - 264);

  await page.keyboard.press("Escape");
  await expect(pane(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
});

test("the no-provider notice's Settings button opens Settings, where AI off removes the pane", async ({
  page,
}) => {
  await openSampleWorld(page);
  await expect(pane(page)).toContainText("Add a provider in Settings to use the assistant.");

  await pane(page).getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const toggle = settings.getByRole("switch", { name: "AI features" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(button(page)).toHaveCount(0);
  await expect(page.locator('aside[aria-label="Assistant"]')).toHaveCount(0);

  await toggle.click();
  await expect(button(page)).toBeVisible();
  await expect(pane(page)).toBeVisible();
});
