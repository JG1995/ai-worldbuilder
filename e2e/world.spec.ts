import { expect, type Locator, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts.
const worldName = "The Glass Steppe";

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const tabNames = (page: Page) => page.getByRole("tab").allTextContents();
const fontFamily = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).fontFamily);

async function openSampleWorld(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
}

test("pages open in tabs, and the tree follows the active tab", async ({ page }) => {
  await openSampleWorld(page);

  await row(page, "Campaign overview").click();
  await expect(tab(page, "Campaign overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 1, name: "Campaign overview" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Campaign overview" })).toContainText(
    "A plain of fused sand",
  );

  await row(page, "Characters").click();
  await row(page, "Brother Ketil").click({ modifiers: ["Control"] });
  await expect(tab(page, "Brother Ketil")).toHaveAttribute("aria-selected", "true");
  await row(page, "Captain Orlaith Venn").click({ button: "middle" });
  await expect(tab(page, "Captain Orlaith Venn")).toHaveAttribute("aria-selected", "true");
  expect(await tabNames(page)).toEqual([
    "Campaign overview",
    "Brother Ketil",
    "Captain Orlaith Venn",
  ]);

  // An open page activates its tab instead of opening another.
  await row(page, "Campaign overview").click();
  await expect(tab(page, "Campaign overview")).toHaveAttribute("aria-selected", "true");
  expect(await tabNames(page)).toHaveLength(3);
  await expect(row(page, "Campaign overview")).toHaveAttribute("aria-selected", "true");

  // Activating a tab selects its row and expands the folders above it.
  await row(page, "Characters").click();
  await expect(row(page, "Brother Ketil")).toHaveCount(0);
  await tab(page, "Brother Ketil").click();
  await expect(row(page, "Characters")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "Brother Ketil")).toHaveAttribute("aria-selected", "true");

  // Closing the active tab activates its right neighbour.
  await page.getByRole("button", { name: "Close Brother Ketil" }).click();
  await expect(tab(page, "Captain Orlaith Venn")).toHaveAttribute("aria-selected", "true");
  expect(await tabNames(page)).toEqual(["Campaign overview", "Captain Orlaith Venn"]);

  // Enter on a page row opens it in the active tab, in place of that tab's page.
  await row(page, "Locations").click();
  await row(page, "Kesh Tor").focus();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  expect(await tabNames(page)).toEqual(["Campaign overview", "Kesh Tor"]);
});

test("code and frontmatter use the mono family, and body text does not", async ({ page }) => {
  await openSampleWorld(page);
  await row(page, "Campaign overview").click();
  const editor = page.getByRole("textbox", { name: "Campaign overview" });
  await expect(editor).toContainText("3d6");

  const line = (text: string) => editor.locator(".cm-line").filter({ hasText: text }).first();
  expect(await fontFamily(line("title: The Glass Steppe"))).toMatch(/^ui-monospace/);
  expect(await fontFamily(line("---"))).toMatch(/^ui-monospace/);
  expect(await fontFamily(line("glass storm (shelter").locator(".cm-mono"))).toMatch(
    /^ui-monospace/,
  );
  expect(await fontFamily(editor.locator(".cm-mono", { hasText: "3d6" }))).toMatch(/^ui-monospace/);
  expect(await fontFamily(line("A plain of fused sand"))).toMatch(/^"Hanken Grotesk"/);
});

test("a page that is not UTF-8 shows its notice and no editor", async ({ page }) => {
  await openSampleWorld(page);

  await row(page, "Locations").click();
  await row(page, "Old trade ledger").click();

  await expect(page.getByRole("alert")).toContainText(
    "This page is not UTF-8 text. It cannot be edited here and has not been changed.",
  );
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("Close world returns to the welcome screen", async ({ page }) => {
  await openSampleWorld(page);

  await page.getByRole("button", { name: "World menu" }).click();
  await page.getByRole("menuitem", { name: "Close world" }).click();

  await expect(page.getByRole("button", { name: "Open world…" })).toBeVisible();
  await expect(page.getByRole("tree")).toHaveCount(0);
});
