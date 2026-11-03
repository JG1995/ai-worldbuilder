import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, whose pages link to each other.
const worldName = "The Glass Steppe";

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const tree = (page: Page) => page.getByRole("tree", { name: worldName });
const treeButton = (page: Page) => page.getByRole("button", { name: "File tree" });
const assistant = (page: Page) => page.getByRole("complementary", { name: "Assistant" });
/** The page region, which is a named region only in the reading view. */
const reading = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const editor = (page: Page, name: string) => page.getByRole("textbox", { name });
const switchView = (page: Page) => page.keyboard.press("ControlOrMeta+e");

async function openSampleWorld(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(tree(page)).toBeVisible();
}

/** Opens Brother Ketil, whose page links to Kesh Tor, in the editing view with focus in it. */
async function openKetil(page: Page, width = 1280) {
  await openSampleWorld(page, width);
  await row(page, "Characters").click();
  await row(page, "Brother Ketil").click();
  await editor(page, "Brother Ketil").click();
  await expect(editor(page, "Brother Ketil")).toBeFocused();
}

test("Read at the table: switch, follow a link and quick open into reading tabs, then switch back with the sidebars restored", async ({
  page,
}) => {
  await openKetil(page);
  await expect(assistant(page)).toBeVisible();

  await switchView(page);
  const ketil = reading(page, "Brother Ketil");
  await expect(ketil).toBeFocused();
  await expect(tree(page)).toBeHidden();
  await expect(assistant(page)).toBeHidden();
  await expect(treeButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Editing view" })).toBeVisible();
  await expect(ketil.locator(".cm-content")).toHaveCSS("font-size", "18px");
  await expect(ketil.locator(".cm-content")).toHaveAttribute("contenteditable", "false");

  await ketil.getByRole("link", { name: "Kesh Tor" }).click();
  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  await expect(reading(page, "Kesh Tor")).toBeVisible();
  await expect(tree(page)).toBeHidden();

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("mirror");
  await expect(page.getByRole("option", { name: /^The mirror lake/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(tab(page, "The mirror lake")).toHaveAttribute("aria-selected", "true");
  await expect(reading(page, "The mirror lake")).toBeVisible();

  await switchView(page);
  await expect(editor(page, "The mirror lake")).toHaveAttribute("contenteditable", "true");
  await expect(tree(page)).toBeVisible();
  await expect(assistant(page)).toBeVisible();
  await expect(treeButton(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reading view" })).toBeVisible();
});

test("Tab reaches each link and then the backlinks, with the focus ring only from the keyboard", async ({
  page,
}) => {
  await openKetil(page);
  await switchView(page);
  const ketil = reading(page, "Brother Ketil");
  await expect(ketil).toBeFocused();

  await page.keyboard.press("Tab");
  const link = ketil.getByRole("link", { name: "Kesh Tor" });
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS("outline-style", "solid");
  await expect(link).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("region", { name: /Linked from/ }).getByRole("button", { name: /^Captain/ }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(link).toBeFocused();

  // A plain click follows without focusing the link, so no focus ring shows on it.
  await tab(page, "Brother Ketil").click();
  await link.click();
  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Brother Ketil").click();
  await expect(link).not.toBeFocused();
  await expect(link).toHaveCSS("outline-style", "none");
});

/** Creates a page of 150 short paragraphs from the tree's New page button, in the editing view. */
async function openLongPage(page: Page, width = 1280) {
  await openSampleWorld(page, width);
  await page
    .getByRole("complementary", { name: "File tree" })
    .getByRole("button", { name: "New page" })
    .click();
  await page.keyboard.type("Long road");
  await page.keyboard.press("Enter");
  await expect(editor(page, "Long road")).toBeFocused();
  const lines = Array.from({ length: 150 }, (_, index) => `Line ${index + 1}`);
  await page.keyboard.insertText(lines.join("\n\n"));
}

/**
 * Scrolls the page region halfway down, then so that the first editor line drawn below its top
 * edge is exactly at the top, and returns that line's text.
 */
async function alignLineToTop(page: Page) {
  await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>("main .overflow-y-auto");
    if (region) region.scrollTop = region.scrollHeight / 2;
  });
  const firstBelowTop = () =>
    page.evaluate(() => {
      const region = document.querySelector<HTMLElement>("main .overflow-y-auto");
      const top = region?.getBoundingClientRect().top ?? 0;
      const line = [...(region?.querySelectorAll<HTMLElement>(".cm-line") ?? [])].find(
        (candidate) => candidate.textContent && candidate.getBoundingClientRect().top >= top,
      );
      if (!region || !line) return null;
      region.scrollTop += line.getBoundingClientRect().top - top;
      return line.textContent;
    });
  // The editor draws the lines there once it has seen the scroll.
  await expect.poll(firstBelowTop).toMatch(/^Line \d+$/);
  return (await firstBelowTop()) ?? "";
}

/** How far below the page region's top the editor line with `text` starts, in pixels. */
function offsetOf(page: Page, text: string) {
  return page.evaluate((text) => {
    const region = document.querySelector<HTMLElement>("main .overflow-y-auto");
    const line = [...(region?.querySelectorAll<HTMLElement>(".cm-line") ?? [])].find(
      (candidate) => candidate.textContent === text,
    );
    if (!region || !line) return Number.NaN;
    return line.getBoundingClientRect().top - region.getBoundingClientRect().top;
  }, text);
}

const scrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>("main .overflow-y-auto")?.scrollTop);

test("switching keeps the line at the top of the page and the editing view's cursor", async ({
  page,
}) => {
  await openLongPage(page);
  const title = page.getByRole("heading", { level: 1, name: "Long road" });

  // With the title at the top, the region stays scrolled to the top.
  // The cursor goes to the start, which the editor scrolls to, and the region to its top.
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(editor(page, "Long road").getByText("Line 1", { exact: true })).toBeInViewport();
  await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>("main .overflow-y-auto");
    if (region) region.scrollTop = 0;
  });
  await expect(title).toBeInViewport();
  for (const _ of ["reading", "editing"]) {
    await switchView(page);
    await expect(title).toBeInViewport();
    expect(await scrollTop(page)).toBe(0);
  }

  const line = await alignLineToTop(page);
  await expect.poll(async () => Math.abs(await offsetOf(page, line))).toBeLessThanOrEqual(0.5);
  // The cursor goes to the end of that line, which is at the region's top.
  const exactly = (text: string) => new RegExp(`^${text}$`);
  await editor(page, "Long road")
    .locator(".cm-line", { hasText: exactly(line) })
    .click();
  for (const _ of ["reading", "editing"]) {
    await switchView(page);
    await expect.poll(async () => Math.abs(await offsetOf(page, line))).toBeLessThanOrEqual(2);
  }
  await page.keyboard.type("~");
  await expect(
    editor(page, "Long road").locator(".cm-line", { hasText: exactly(`${line}~`) }),
  ).toHaveCount(1);
});

test("the arrow keys and End scroll the focused reading page", async ({ page }) => {
  await openLongPage(page);
  await switchView(page);
  await expect(reading(page, "Long road")).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
  await page.keyboard.press("End");
  await expect(reading(page, "Long road").getByText("Line 150", { exact: true })).toBeInViewport();
});

test("copying a selection in the reading view gives its Markdown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openKetil(page);
  await switchView(page);

  await reading(page, "Brother Ketil")
    .getByText("Keeper of the shrine at")
    .click({ clickCount: 3 });
  await page.keyboard.press("ControlOrMeta+c");

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("Keeper of the shrine at [[Kesh Tor]].");
});

test("the view and the reading layout survive reopening the world", async ({ page }) => {
  await openKetil(page);
  await switchView(page);
  await expect(reading(page, "Brother Ketil")).toBeVisible();

  await treeButton(page).click();
  await page.getByRole("button", { name: "World menu" }).click();
  await page.getByRole("menuitem", { name: "Close world" }).click();
  await page
    .getByRole("region", { name: "Recent worlds" })
    .getByRole("button", { name: new RegExp(worldName) })
    .click();

  await expect(reading(page, "Brother Ketil")).toBeVisible();
  await expect(tree(page)).toBeHidden();
  await expect(treeButton(page)).toBeVisible();
});

for (const width of [1280, 1024, 720]) {
  test(`at ${width}px the reading layout shows the tree button, which opens the tree`, async ({
    page,
  }) => {
    await openKetil(page);
    await page.setViewportSize({ width, height: 800 });
    await switchView(page);
    await expect(tree(page)).toBeHidden();

    await treeButton(page).click();
    await expect(tree(page)).toBeVisible();
    await treeButton(page).click();
    await expect(tree(page)).toBeHidden();

    await switchView(page);
    await expect(treeButton(page)).toHaveCount(width < 960 ? 1 : 0);
  });
}
