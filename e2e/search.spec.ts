import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, whose search approximates the
// core's: names, aliases and paths, and the words of the pages' text, with letter case and accents
// ignored.
const worldName = "The Glass Steppe";

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Search pages" });
const query = (page: Page) => page.getByRole("combobox", { name: "Search pages" });

/** Opens the sample world and its Campaign overview, with focus in the page's editor. */
async function openOverview(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
  await row(page, "Campaign overview").click();
  const editor = page.getByRole("textbox", { name: "Campaign overview" });
  await editor.click();
  await expect(editor).toBeFocused();
}

test("Ctrl+O, part of a name and Enter open the page in the current tab, with focus in its editor", async ({
  page,
}) => {
  await openOverview(page);

  await page.keyboard.press("Control+o");
  await expect(query(page)).toBeFocused();
  await page.keyboard.type("kesh");
  await expect(page.getByRole("option", { name: /^Kesh Tor/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");

  await expect(dialog(page)).toHaveCount(0);
  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Campaign overview")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Kesh Tor" })).toBeFocused();
});

test("Ctrl+K finds a page by its alias, and Ctrl+Enter opens it in a new tab", async ({ page }) => {
  await openOverview(page);

  await page.keyboard.press("Control+k");
  await page.keyboard.type("caravan");
  const venn = page.getByRole("option", { name: /^Captain Orlaith Venn/ });
  await expect(venn).toContainText("alias: The caravan master");
  await page.keyboard.press("Control+Enter");

  await expect(tab(page, "Captain Orlaith Venn")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Campaign overview")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Captain Orlaith Venn" })).toBeFocused();
});

test("words from a page's text list its line, which opens the page with the cursor at the match", async ({
  page,
}) => {
  await openOverview(page);

  await page.keyboard.press("Control+o");
  await page.keyboard.type("basalt spi");
  const line = page
    .getByRole("group", { name: "Kesh Tor, Locations" })
    .getByRole("option", { name: "A basalt spire, the only shade for a day's ride." });
  await expect(line).toBeVisible();
  // No page has the name, so the Create row comes first.
  await page.keyboard.press("ArrowDown");
  await expect(line).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(dialog(page)).toHaveCount(0);
  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  const editor = page.getByRole("textbox", { name: "Kesh Tor" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("~");
  await expect(editor).toContainText("A ~basalt spire");
});

test("the tree's Search button opens the dialog, and Escape returns focus to it", async ({
  page,
}) => {
  await openOverview(page);
  const button = page.getByRole("button", { name: "Search pages" });

  await button.click();
  await expect(query(page)).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(dialog(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("a press on the dialog's own text keeps focus in the input, so Escape still closes it", async ({
  page,
}) => {
  await openOverview(page);

  await page.keyboard.press("Control+o");
  await page.keyboard.type("zzzz");
  await page.getByText('Nothing matches "zzzz".', { exact: true }).click();
  await expect(query(page)).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Campaign overview" })).toBeFocused();
});

test("picking Create for a new name creates the page in the active page's folder and opens it", async ({
  page,
}) => {
  await openOverview(page);
  await row(page, "Locations").click();
  await row(page, "Kesh Tor").click();
  await expect(page.getByRole("textbox", { name: "Kesh Tor" })).toBeVisible();

  await page.keyboard.press("Control+o");
  await page.keyboard.type("Saltmere harbour office");
  await expect(
    page.getByText('Nothing matches "Saltmere harbour office".', { exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: 'Create page "Saltmere harbour office"' }).click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(tab(page, "Saltmere harbour office")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Kesh Tor")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Saltmere harbour office" })).toBeFocused();
  await expect(row(page, "Saltmere harbour office")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "Saltmere harbour office")).toHaveAttribute("aria-level", "2");
});
