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

/** The preview world's stored text of a page, read from the fixture module the app itself loaded. */
function storedText(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const fixtures = "/src/lib/preview-fixtures.ts";
    const { previewFixtures } = await import(/* @vite-ignore */ fixtures);
    return previewFixtures.page_read({ path }).text as string;
  }, path);
}

/** Closes a tab with its close button, which shows while the tab is hovered. */
async function closeTab(page: Page, name: string) {
  await tab(page, name).hover();
  await page.getByRole("button", { name: `Close ${name}` }).click();
}

async function typeAtEnd(page: Page, editorName: string, text: string) {
  await page.getByRole("textbox", { name: editorName }).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

test("typed text saves within two seconds of a pause, and the page shows it again", async ({
  page,
}) => {
  await openSampleWorld(page);
  await row(page, "Characters").click();
  await row(page, "Brother Ketil").click();

  await typeAtEnd(page, "Brother Ketil", "\nSworn to silence.");

  await expect
    .poll(() => storedText(page, "Characters/Brother Ketil.md"), { timeout: 2000 })
    .toContain("Sworn to silence.");
  await closeTab(page, "Brother Ketil");
  await row(page, "Brother Ketil").click();
  await expect(page.getByRole("textbox", { name: "Brother Ketil" })).toContainText(
    "Sworn to silence.",
  );
});

test("Ctrl+S saves at once", async ({ page }) => {
  await openSampleWorld(page);
  await row(page, "Session notes").click();
  await row(page, "Session 1").click();
  await typeAtEnd(page, "Session 1", " They leave at dusk.");

  await page.keyboard.press("Control+s");

  // Well within the one-second autosave delay.
  await expect
    .poll(() => storedText(page, "Session notes/Session 1.md"), { timeout: 500 })
    .toContain("They leave at dusk.");
});

test("a page that cannot be saved shows the failed-save notice, and closing it asks first", async ({
  page,
}) => {
  await openSampleWorld(page);
  await row(page, "Locations").click();
  await row(page, "Locked chronicle").click();

  await typeAtEnd(page, "Locked chronicle", " A new line.");

  await expect(page.getByRole("alert")).toContainText(
    "This page could not be saved: Another program is using the file.",
  );
  await closeTab(page, "Locked chronicle");
  const dialog = page.getByRole("dialog", { name: '"Locked chronicle" could not be saved' });
  await expect(dialog).toContainText("Another program is using the file.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(tab(page, "Locked chronicle")).toBeVisible();
});
