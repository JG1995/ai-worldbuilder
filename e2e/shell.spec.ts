import { expect, type Locator, type Page, test } from "@playwright/test";

async function openSampleWorld(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/showcase.html#sample-world");
  await expect(page.getByRole("heading", { name: "Sample world screen" })).toBeVisible();
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element has no box.");
  return found;
}

const treePane = (page: Page) => page.getByRole("complementary", { name: "File tree" });
const toggle = (page: Page) => page.getByRole("button", { name: "File tree" });

test("at 1280px the tree and page sit side by side, and the resizer stays within bounds", async ({
  page,
}) => {
  await openSampleWorld(page, 1280);
  const tree = await box(treePane(page));
  const main = await box(page.getByRole("main"));
  expect(tree.width).toBe(264);
  expect(main.x).toBe(tree.x + tree.width);
  await expect(toggle(page)).toHaveCount(0);

  const separator = page.getByRole("separator", { name: "File tree width" });
  const handle = await box(separator);
  await page.mouse.move(handle.x + 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + 102, handle.y + 100);
  await expect(separator).toHaveAttribute("aria-valuenow", "364");
  await page.mouse.move(handle.x + 600, handle.y + 100);
  await expect(separator).toHaveAttribute("aria-valuenow", "420");
  await page.mouse.move(0, handle.y + 100);
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "200");
  expect((await box(treePane(page))).width).toBe(200);
});

test("at 720px the toggle opens the overlay, and Escape closes it after any tooltip", async ({
  page,
}) => {
  await openSampleWorld(page, 720);
  await expect(treePane(page)).toBeHidden();

  await toggle(page).click();
  await expect(treePane(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  // The toggle keeps focus, so its own tooltip shows; the first Escape closes only that.
  await expect(page.getByRole("tooltip", { name: "File tree" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip", { name: "File tree" })).toBeHidden();
  await expect(treePane(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(treePane(page)).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("tooltips and the context menu inside the open overlay sit at their anchors", async ({
  page,
}) => {
  await openSampleWorld(page, 720);
  await toggle(page).click();
  // The slide ends with no translate, so the overlay is no containing block for fixed elements.
  await expect
    .poll(() => treePane(page).evaluate((element) => getComputedStyle(element).translate))
    .toBe("none");

  const newPage = treePane(page).getByRole("button", { name: "New page" });
  await newPage.hover();
  const tooltip = page.getByRole("tooltip", { name: "New page" });
  await expect(tooltip).toBeVisible();
  const button = await box(newPage);
  const tip = await box(tooltip);
  expect(tip.y).toBeCloseTo(button.y + button.height + 4, 0);
  expect(tip.x + tip.width / 2).toBeCloseTo(button.x + button.width / 2, 0);

  const row = await box(page.getByRole("treeitem", { name: "People" }));
  await page.mouse.click(row.x + 40, row.y + 10, { button: "right" });
  const menu = await box(page.getByRole("menu"));
  expect(menu.x).toBeCloseTo(row.x + 40, 0);
  expect(menu.y).toBeCloseTo(row.y + 14, 0);
});

test("Escape that cancels the tree's name input leaves the overlay open", async ({ page }) => {
  await openSampleWorld(page, 720);
  await toggle(page).click();
  await treePane(page).getByRole("button", { name: "New page" }).click();
  const input = page.getByRole("textbox", { name: "New page name" });
  await expect(input).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(treePane(page)).toBeVisible();
});

test("crossing 960px turns the open overlay into the side pane, and narrowing closes it", async ({
  page,
}) => {
  await openSampleWorld(page, 720);
  await toggle(page).click();
  await page.keyboard.press("F6");
  const newPage = treePane(page).getByRole("button", { name: "New page" });
  await expect(newPage).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toggle(page)).toHaveCount(0);
  await expect(treePane(page)).toBeVisible();
  await expect(newPage).toBeFocused();

  await page.setViewportSize({ width: 720, height: 800 });
  await expect(treePane(page)).toBeHidden();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page)).toBeFocused();
});

test("with many tabs the overflow menu lists every tab and shows the chosen one", async ({
  page,
}) => {
  await openSampleWorld(page, 1280);
  await page.getByRole("button", { name: "Open every page" }).click();
  const tabs = page.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBe(12);

  await page.getByRole("button", { name: "All tabs" }).click();
  const items = page.getByRole("menuitem");
  await expect(items).toHaveCount(count);
  await items.last().click();

  const last = tabs.last();
  await expect(last).toHaveAttribute("aria-selected", "true");
  const strip = await box(page.getByRole("tablist").locator(".."));
  const tab = await box(last.locator(".."));
  expect(tab.x).toBeGreaterThanOrEqual(strip.x);
  expect(tab.x + tab.width).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
});

test("Ctrl+Tab reaches the tab strip in the browser preview", async ({ page }) => {
  await openSampleWorld(page, 1280);
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Control+Tab");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+Tab");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
});

test("a toast pushed while a dialog is open shows above the dialog", async ({ page }) => {
  await page.clock.install();
  await openSampleWorld(page, 1280);
  await page.getByRole("button", { name: "Push a toast in 2 seconds" }).click();
  await page.getByRole("treeitem", { name: "Saltmere" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Delete…/ }).click();
  await expect(page.getByRole("dialog", { name: 'Delete "Saltmere"?' })).toBeVisible();

  await page.clock.runFor(2000);
  const toast = page.getByRole("listitem").filter({ hasText: "Sample toast" });
  await expect(toast).toBeVisible();
  const { x, y, width, height } = await box(toast);
  const onTop = await toast.evaluate(
    (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
    { x: x + width / 2, y: y + height / 2 },
  );
  expect(onTop).toBe(true);
});
