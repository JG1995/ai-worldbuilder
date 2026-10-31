import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, which keeps a history of the
// pages saved while the preview page stays loaded.
const worldName = "The Glass Steppe";

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });

async function openSampleWorld(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
}

test("an edited page's earlier version is restored from its history, and the restore undone", async ({
  page,
}) => {
  await openSampleWorld(page);
  await row(page, "Locations").click();
  await row(page, "Kesh Tor").click();
  const editor = page.getByRole("textbox", { name: "Kesh Tor" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Ravens nest on its crown.");

  await row(page, "Kesh Tor").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^History/ }).click();

  const history = page.getByRole("region", { name: "History" });
  const earlier = history.getByRole("option", { selected: true });
  await expect(earlier).toContainText("Changed outside Grimoire.md");
  await expect(earlier).toBeFocused();
  await expect(history.getByRole("option").first()).toHaveText("Current");
  await expect(history.getByRole("list", { name: "Differences" })).toContainText(
    "Only in the current text: Ravens nest on its crown.",
  );

  await history.getByRole("button", { name: "Restore this version" }).click();

  await expect(history).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor).not.toContainText("Ravens nest");
  const toast = page.getByRole("status").getByRole("listitem");
  await expect(toast).toContainText("Restored the version from");

  await toast.getByRole("button", { name: "Undo" }).click();

  await expect(editor).toContainText("Ravens nest on its crown.");
});

test("Ctrl+Shift+H from the editor shows the active page's history", async ({ page }) => {
  await openSampleWorld(page);
  await row(page, "Campaign overview").click();
  await page.getByRole("textbox", { name: "Campaign overview" }).click();

  await page.keyboard.press("Control+Shift+H");

  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByRole("option", { selected: true })).toBeFocused();
  await expect(history).toContainText("Earlier versions appear once Grimoire.md saves this page.");
});
