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
    "",
    "",
  ]);
  await expect(lines(page).nth(4)).toHaveClass(/cm-heading-2/);
  await expect(lines(page).locator(".cm-em")).toHaveCSS("font-style", "italic");
  await expect(lines(page).locator(".cm-strong")).toHaveCSS("font-weight", "700");
  await expect(editor(page).locator(".cm-link")).toHaveText([
    "Glasswrights' Guild",
    "lens makers",
    "Glasswrights' Guild",
  ]);
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

const grids = (page: Page) => editor(page).getByRole("table");
const stones = (page: Page) => grids(page).first();

test("a table shows as a grid with aligned columns, formatted cells and rows fitted to its header", async ({
  page,
}) => {
  await openWardStones(page);

  const rows = stones(page).getByRole("row");
  await expect(rows.nth(0).getByRole("columnheader")).toHaveText(["Stone", "Weight", "Found by"]);
  await expect(rows.nth(1).getByRole("cell")).toHaveText([
    "Granite",
    "9 kg",
    "Glasswrights' Guild",
  ]);
  await expect(rows.nth(2).getByRole("cell")).toHaveText(["Slate", "4 kg", ""]);
  await expect(rows.nth(3).getByRole("cell")).toHaveText(["Flint", "2 kg", "a rider"]);
  await expect(rows.nth(0).getByRole("columnheader").first()).toHaveCSS("font-weight", "700");
  const aligned = rows.nth(1).getByRole("cell");
  for (const [index, alignment] of ["left", "center", "right"].entries()) {
    await expect(aligned.nth(index)).toHaveCSS("text-align", alignment);
  }
  await expect(aligned.nth(0).locator(".cm-strong")).toHaveText("Granite");
  await expect(aligned.nth(1).locator(".cm-code")).toHaveText("9 kg");
});

test("clicking a cell shows the table as Markdown with the cursor there, and leaving it shows the edit", async ({
  page,
}) => {
  await openWardStones(page);
  const slate = stones(page).getByRole("cell", { name: "Slate", exact: true });

  // Just inside the cell's padding: before the first character of its text.
  await slate.click({ position: { x: 9, y: 8 } });
  await expect(grids(page)).toHaveCount(1);
  await expect(lines(page).nth(36)).toHaveText("| Slate | 4 kg |");
  await page.keyboard.type("Blue ");
  await expect(lines(page).nth(36)).toHaveText("| Blue Slate | 4 kg |");

  await lines(page).nth(0).click();
  await expect(grids(page)).toHaveCount(2);
  await expect(stones(page).getByRole("row").nth(2).getByRole("cell")).toHaveText([
    "Blue Slate",
    "4 kg",
    "",
  ]);
  await expect.poll(() => storedText(page), { timeout: 2000 }).toContain("| Blue Slate | 4 kg |\n");
});

test("the arrow keys move the cursor into a table, which shows it as Markdown, and out again", async ({
  page,
}) => {
  await openWardStones(page);
  await lines(page).nth(31).click();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(grids(page)).toHaveCount(1);
  await expect(lines(page).nth(33)).toHaveText("| Stone | Weight | Found by |");
  await page.keyboard.type("~");
  await expect(lines(page).nth(33)).toHaveText("~| Stone | Weight | Found by |");
  await page.keyboard.press("Backspace");

  // Down through the table's lines to the line between the two tables shows both as grids.
  for (let pressed = 0; pressed < 5; pressed++) await page.keyboard.press("ArrowDown");
  await expect(grids(page)).toHaveCount(2);
  await page.keyboard.press("ArrowUp");
  await expect(grids(page)).toHaveCount(1);
  await expect(lines(page).nth(37)).toHaveText("| Flint | 2 kg | a rider | lost |");
});

test("Ctrl+click on a link in a cell follows it", async ({ page }) => {
  await openWardStones(page);

  await stones(page)
    .locator(".cm-link")
    .click({ modifiers: ["Control"] });

  await expect(page.getByRole("tab", { name: "Glasswrights' Guild" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a wide grid scrolls inside its own area, and the page does not", async ({ page }) => {
  await openWardStones(page);

  const wrapper = grids(page).nth(1).locator("xpath=..");
  const widths = await wrapper.evaluate((element) => {
    let scroller = element.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
      scroller = scroller.parentElement;
    }
    return {
      grid: element.scrollWidth,
      wrapper: element.clientWidth,
      page: scroller?.scrollWidth,
      pageShown: scroller?.clientWidth,
    };
  });
  expect(widths.grid).toBeGreaterThan(widths.wrapper);
  expect(widths.page).toBe(widths.pageShown);
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
  const cell = stones(page).getByRole("cell").first();
  await expect(cell).toHaveCSS("border-top-style", "solid");
  await expect(cell).toHaveCSS("border-top-width", "1px");
});
