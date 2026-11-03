import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, whose page Ward stones holds
// every element the live preview formats.
const path = "Ward stones.md";

const editor = (page: Page) => page.getByRole("textbox", { name: "Ward stones" });
const lines = (page: Page) => editor(page).locator(".cm-line");

/** Opens Ward stones, whose cursor starts on its first line, and waits for its links. */
async function openWardStones(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await page.getByRole("treeitem", { name: "Ward stones", exact: true }).click();
  await expect(editor(page).locator(".cm-link-unresolved")).toHaveText("Ash road");
}

function storedText(page: Page) {
  return page.evaluate(async (path) => {
    const fixtures = "/src/lib/preview-fixtures.ts";
    const { previewFixtures } = await import(/* @vite-ignore */ fixtures);
    return previewFixtures.page_read({ path }).text as string;
  }, path);
}

test("away from the cursor, each element shows formatted with its syntax hidden", async ({
  page,
}) => {
  await openWardStones(page);

  await expect(lines(page)).toHaveText([
    "# Ward stones",
    "",
    "Old circles mark safe ground on dark nights.",
    "",
    "Signs",
    "",
    "Riders read three marks: smoke, ash and 2d4 for luck. #lore Keep quiet at sessions.",
    "",
    "Warning",
    "Never sleep outside a ring.",
    "",
    "Placing a ring",
    "Seven stones, set at dusk.",
    "",
    "A rider's saying: stones remember.",
    "",
    "• Count every stone",
    "• Mark a map",
    "• Spare chalk",
    "",
    "1. Walk around once",
    "2. Speak a name",
    "",
    "Guild records: Glasswrights' Guild, lens makers and Ash road.",
    "",
    "",
    "",
    "",
    "ring = 7 stones",
    "",
    "",
    "A plain link and an escaped *star*.",
    "",
  ]);
  await expect(lines(page).nth(4)).toHaveClass(/cm-heading-2/);
  await expect(editor(page).locator(".cm-em")).toHaveCSS("font-style", "italic");
  await expect(editor(page).locator(".cm-strong")).toHaveCSS("font-weight", "700");
  await expect(editor(page).locator(".cm-link")).toHaveText(["Glasswrights' Guild", "lens makers"]);
  await expect(page.getByRole("checkbox", { name: "Count every stone" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByRole("checkbox", { name: "Mark a map" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(await storedText(page)).toContain("## Signs\n");
});

test("clicking into a line shows its Markdown as typed", async ({ page }) => {
  await openWardStones(page);

  await lines(page).nth(6).click();

  await expect(lines(page).nth(6)).toHaveText(
    "Riders read **three** marks: ~~smoke~~, ==ash== and `2d4` for luck. #lore %%Keep quiet at sessions.%%",
  );
  await expect(lines(page).nth(0)).toHaveText("Ward stones");
  await expect(lines(page).nth(6).locator(".cm-strong")).toHaveText("**three**");
});

test("ticking a checkbox saves the page with [x] and leaves the cursor where it was", async ({
  page,
}) => {
  await openWardStones(page);

  await page.getByRole("checkbox", { name: "Count every stone" }).click();

  await expect(page.getByRole("checkbox", { name: "Count every stone" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The press did not move the cursor: its first line still shows as typed, the task's does not.
  await expect(lines(page).nth(0)).toHaveText("# Ward stones");
  await expect(lines(page).nth(16)).toHaveText("• Count every stone");
  await expect
    .poll(() => storedText(page), { timeout: 2000 })
    .toContain("- [x] Count every stone\n- [x] Mark a map\n");
});

test("under forced colours, links keep their underline and checkboxes their border", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openWardStones(page);

  for (const link of await editor(page).locator(".cm-link, .cm-link-unresolved").all()) {
    await expect(link).toHaveCSS("text-decoration-line", "underline");
  }
  const box = page.getByRole("checkbox", { name: "Count every stone" });
  await expect(box).toHaveCSS("border-top-style", "solid");
  await expect(box).toHaveCSS("border-top-width", "1px");
});
