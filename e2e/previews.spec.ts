import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, where Ward stones has a
// "Signs" heading below its first lines and Kesh Tor a short text.
const worldName = "The Glass Steppe";

const lines = [
  "Rules: [[Ward stones#Signs]] and [[Kesh Tor]].",
  "",
  "| Where |",
  "| --- |",
  "| [[Kesh Tor]] |",
  "",
  "The end.",
];

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const editor = (page: Page) => page.getByRole("textbox", { name: "Rules" });
const link = (page: Page, text: string) => editor(page).locator(".cm-link", { hasText: text });
const preview = (page: Page) => page.locator(".cm-link-preview");

/** Opens the sample world and creates a page of `lines`, with the cursor on its last line. */
async function openRules(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
  await page
    .getByRole("complementary", { name: "File tree" })
    .getByRole("button", { name: "New page" })
    .click();
  await page.keyboard.type("Rules");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText(lines.join("\n"));
  await expect(link(page, "Ward stones > Signs")).toBeVisible();
}

test("a resting pointer previews the linked page at its heading, and a click on the preview opens it in a new tab", async ({
  page,
}) => {
  await openRules(page);
  const signs = link(page, "Ward stones > Signs");

  await signs.hover();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator(".cm-link-preview-title")).toHaveText("Ward stones");
  const [linkBox, previewBox] = await Promise.all([
    signs.boundingBox(),
    preview(page).boundingBox(),
  ]);
  expect(previewBox?.y).toBeGreaterThan((linkBox?.y ?? 0) + (linkBox?.height ?? 0) - 1);
  expect(previewBox?.width).toBeLessThanOrEqual(400);
  expect(previewBox?.height).toBeLessThanOrEqual(320);
  // The page starts at the linked heading, in the reading view's rendering.
  const shown = page.getByRole("textbox", { name: "Ward stones" });
  await expect(shown).toHaveAttribute("contenteditable", "false");
  const heading = shown.locator(".cm-line", { hasText: /^Signs$/ });
  const scroller = preview(page).locator(".cm-scroller");
  await expect
    .poll(async () => {
      const [line, area] = await Promise.all([heading.boundingBox(), scroller.boundingBox()]);
      return Math.abs((line?.y ?? 0) - (area?.y ?? 100));
    })
    .toBeLessThan(2);

  await preview(page).hover();
  await expect(preview(page)).toBeVisible();
  await page.mouse.move(640, 700);
  await expect(preview(page)).toBeHidden();

  await signs.hover();
  await preview(page).click();
  await expect(tab(page, "Ward stones")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Rules")).toBeVisible();
  await expect(preview(page)).toBeHidden();
});

test("a link in a grid previews its page, and activating another tab closes the preview", async ({
  page,
}) => {
  await openRules(page);
  await link(page, "Ward stones > Signs").click({ modifiers: ["ControlOrMeta"] });
  await expect(tab(page, "Ward stones")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Rules").click();

  await editor(page).locator(".cm-table .cm-link", { hasText: "Kesh Tor" }).hover();
  await expect(preview(page)).toContainText("A basalt spire");
  await page.keyboard.press("Control+Tab");

  await expect(tab(page, "Ward stones")).toHaveAttribute("aria-selected", "true");
  await expect(preview(page)).toBeHidden();
});

test("the reading view previews a linked page the same way", async ({ page }) => {
  await openRules(page);
  await page.keyboard.press("ControlOrMeta+e");
  const rules = page.getByRole("region", { name: "Rules", exact: true });
  await expect(rules).toBeFocused();

  await rules.getByRole("link", { name: "Kesh Tor" }).first().hover();
  await expect(preview(page)).toContainText("A basalt spire");
  // Opening the preview leaves the focus where it was.
  await expect(rules).toBeFocused();
  await preview(page).click();

  await expect(tab(page, "Kesh Tor")).toHaveAttribute("aria-selected", "true");
  await expect(preview(page)).toBeHidden();
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a preview fades in unless motion is reduced: ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await openRules(page);

    await link(page, "Kesh Tor").first().hover();

    await expect(preview(page)).toBeVisible();
    await expect(preview(page)).toHaveCSS(
      "transition-duration",
      reducedMotion === "reduce" ? "0s" : "0.12s",
    );
  });
}
