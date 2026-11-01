import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, whose pages link to each other.
const worldName = "The Glass Steppe";

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const backlinks = (page: Page) => page.getByRole("region", { name: /Linked from/ });

async function openKeshTor(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
  await row(page, "Locations").click();
  await row(page, "Kesh Tor").click();
  await expect(page.getByRole("textbox", { name: "Kesh Tor" })).toBeVisible();
}

test("a page lists the pages that link to it below its editor", async ({ page }) => {
  await openKeshTor(page);

  const section = backlinks(page);
  await expect(section.getByRole("heading")).toHaveText(/Linked from\s*2/i);
  await expect(section.getByRole("button")).toHaveText([
    /^Brother Ketil\s*Keeper of the shrine at \[\[Kesh Tor\]\]\.$/,
    /^Session 2\s*A glass storm strands the caravan at \[\[Kesh Tor#Shelter\]\]\.$/,
  ]);
});

test("choosing a backlink opens the linking page with the cursor at the link", async ({ page }) => {
  await openKeshTor(page);

  await backlinks(page)
    .getByRole("button", { name: /^Brother Ketil/ })
    .click();

  await expect(tab(page, "Brother Ketil")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Kesh Tor")).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "Brother Ketil" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("~");
  await expect(editor).toContainText("Keeper of the shrine at ~[[Kesh Tor]].");
});

/** Opens a page of the sample world from the tree, inside `folder`. */
async function openPage(page: Page, folder: string, name: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await row(page, folder).click();
  await row(page, name).click();
  return page.getByRole("textbox", { name });
}

test("resolved and unresolved links show their styles in the editor", async ({ page }) => {
  const ketil = await openPage(page, "Characters", "Brother Ketil");
  const resolved = ketil.locator(".cm-link");
  await expect(resolved).toHaveText("[[Kesh Tor]]");
  await expect(resolved).toHaveCSS("text-decoration-style", "solid");

  await row(page, "The salt merchant").click();
  const merchant = page.getByRole("textbox", { name: "The salt merchant" });
  const unresolved = merchant.locator(".cm-link-unresolved");
  await expect(unresolved).toHaveText("[[Saltmere]]");
  await expect(unresolved).toHaveCSS("text-decoration-style", "dashed");
  await expect(merchant.locator(".cm-link")).toHaveCount(0);
});

test("Ctrl+click on a link opens its page in a new tab", async ({ page }) => {
  const editor = await openPage(page, "Characters", "Brother Ketil");

  await editor.locator(".cm-link").click({ modifiers: ["ControlOrMeta"] });

  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Brother Ketil")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Kesh Tor" })).toBeFocused();
});

test("Alt+Enter in a link follows it without changing the text", async ({ page }) => {
  const editor = await openPage(page, "Characters", "Brother Ketil");
  await editor.locator(".cm-link").click();

  await page.keyboard.press("Alt+Enter");

  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Brother Ketil").click();
  const lines = page.getByRole("textbox", { name: "Brother Ketil" }).locator(".cm-line");
  await expect(lines).toHaveText([
    "# Brother Ketil",
    "",
    "Keeper of the shrine at [[Kesh Tor]].",
    "",
  ]);
});

test("Ctrl+click on an unresolved link creates its page and opens it", async ({ page }) => {
  const editor = await openPage(page, "Characters", "The salt merchant");

  await editor.locator(".cm-link-unresolved").click({ modifiers: ["ControlOrMeta"] });

  await expect(tab(page, "Saltmere")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "Saltmere")).toBeVisible();
  const created = page.getByRole("textbox", { name: "Saltmere" });
  await expect(created).toBeFocused();
  await expect(created).toHaveText("");
});

test("Ctrl+Enter on a backlink opens it in a new tab", async ({ page }) => {
  await openKeshTor(page);

  await backlinks(page)
    .getByRole("button", { name: /^Session 2/ })
    .focus();
  await page.keyboard.press("Control+Enter");

  await expect(tab(page, "Session 2")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Kesh Tor")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Session 2" })).toBeFocused();
});
