import { expect, type Page, test } from "@playwright/test";

// The browser preview's sample world in src/lib/preview-fixtures.ts, whose `link_open` records each
// address it is asked to open and opens nothing; addresses on unopenable.example fail.
const worldName = "The Glass Steppe";

const lines = [
  "Charts: [the docks](https://docks.example/map) and <https://unopenable.example/sea>.",
  "",
  "| Where | Chart |",
  "| --- | --- |",
  "| Ford | www.ford.example |",
  "",
  "The end.",
];

const editor = (page: Page) => page.getByRole("textbox", { name: "Charts" });
const webLink = (page: Page, text: string) =>
  editor(page).locator(".cm-web-link", { hasText: text });

/** Opens the sample world and creates a page of `lines`, with the cursor on its last line. */
async function openCharts(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: worldName })).toBeVisible();
  await page
    .getByRole("complementary", { name: "File tree" })
    .getByRole("button", { name: "New page" })
    .click();
  await page.keyboard.type("Charts");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText(lines.join("\n"));
  await expect(webLink(page, "the docks")).toBeVisible();
}

/** The addresses the preview's `link_open` was asked to open so far. */
function opened(page: Page) {
  return page.evaluate(async () => {
    const fixtures = "/src/lib/preview-fixtures.ts";
    const { openedAddresses } = await import(/* @vite-ignore */ fixtures);
    return [...openedAddresses] as string[];
  });
}

test("the editing view opens a web link on Ctrl/Cmd+click and Alt+Enter, and not on a plain click", async ({
  page,
}) => {
  await openCharts(page);

  await webLink(page, "the docks").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => opened(page)).toEqual(["https://docks.example/map"]);

  await editor(page)
    .locator(".cm-table")
    .getByText("www.ford.example")
    .click({
      modifiers: ["ControlOrMeta"],
    });
  await expect.poll(() => opened(page)).toHaveLength(2);

  // A plain click only moves the cursor, which shows the line's Markdown.
  await webLink(page, "the docks").click();
  await expect(editor(page).locator(".cm-line").first()).toHaveText(lines[0]);
  await page.keyboard.press("Alt+Enter");
  await expect
    .poll(() => opened(page))
    .toEqual(["https://docks.example/map", "http://www.ford.example", "https://docks.example/map"]);
  await expect(editor(page).locator(".cm-line").first()).toHaveText(lines[0]);
});

test("the reading view opens a web link on a click and on Enter, and shows its address on focus and hover", async ({
  page,
}) => {
  await openCharts(page);
  await page.keyboard.press("ControlOrMeta+e");
  const charts = page.getByRole("region", { name: "Charts", exact: true });
  await expect(charts).toBeFocused();
  const docks = charts.getByRole("link", { name: "the docks" });

  await docks.click();
  await expect.poll(() => opened(page)).toEqual(["https://docks.example/map"]);

  await page.keyboard.press("Tab");
  await expect(docks).toBeFocused();
  await expect(docks).toHaveCSS("outline-style", "solid");
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("https://docks.example/map");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const ford = charts.getByRole("link", { name: "www.ford.example" });
  await expect(ford).toBeFocused();
  await expect(tooltip).toHaveText("http://www.ford.example");
  await page.keyboard.press("Enter");
  await expect.poll(() => opened(page)).toContain("http://www.ford.example");

  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  // The pointer still rests on the link it clicked, so it leaves it first.
  await page.mouse.move(0, 0);
  await docks.hover();
  await expect(tooltip).toHaveText("https://docks.example/map");
  const [link, shown] = await Promise.all([docks.boundingBox(), tooltip.boundingBox()]);
  expect(shown?.y).toBeGreaterThan((link?.y ?? 0) + (link?.height ?? 0) - 1);
});

test("a web link that cannot be opened shows a toast with the reason", async ({ page }) => {
  await openCharts(page);

  await webLink(page, "unopenable").click({ modifiers: ["ControlOrMeta"] });

  await expect(
    page.getByText("The link could not be opened: No browser could be started."),
  ).toBeVisible();
  expect(await opened(page)).toEqual(["https://unopenable.example/sea"]);
});

test("under forced colours, a web link keeps its underline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openCharts(page);

  await expect(webLink(page, "the docks")).toHaveCSS("text-decoration-line", "underline");
});
