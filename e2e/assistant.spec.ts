import { expect, type Locator, type Page, test } from "@playwright/test";

// The browser preview's settings in src/lib/preview-fixtures.ts start with AI on and no provider,
// and its sample world opens with the assistant's side pane open at its default width.

const pane = (page: Page) => page.getByRole("complementary", { name: "Assistant" });
const button = (page: Page) => page.getByRole("button", { name: "Assistant" });

async function openSampleWorld(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: "The Glass Steppe" })).toBeVisible();
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element has no box.");
  return found;
}

test("the button and Ctrl+Shift+A close and open the side pane, and opening focuses it", async ({
  page,
}) => {
  await openSampleWorld(page);
  await expect(pane(page)).toBeVisible();
  await expect(pane(page)).toContainText("Assistant");
  const main = await box(page.getByRole("main"));
  const side = await box(pane(page));
  expect(side.width).toBe(360);
  expect(side.x).toBe(main.x + main.width);

  await button(page).click();
  await expect(pane(page)).toBeHidden();
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  await button(page).click();
  await expect(pane(page)).toBeVisible();
  // Without a provider, the notice's Settings button is the pane's first control.
  await expect(pane(page).getByRole("button", { name: "Settings" })).toBeFocused();

  await page.keyboard.press("Control+Shift+A");
  await expect(pane(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Control+Shift+A");
  await expect(pane(page)).toBeVisible();
  await expect(pane(page).getByRole("button", { name: "Settings" })).toBeFocused();
});

test("the pane's edge resizes it by keyboard within 300px to 560px", async ({ page }) => {
  await openSampleWorld(page);
  const separator = page.getByRole("separator", { name: "Assistant width" });

  await separator.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "376");
  expect((await box(pane(page))).width).toBe(376);
  for (let step = 0; step < 20; step++) await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  expect((await box(pane(page))).width).toBe(300);
});

test("F6 cycles the tree, the page column and the pane", async ({ page }) => {
  await openSampleWorld(page);
  const settings = pane(page).getByRole("button", { name: "Settings" });

  await page.getByRole("treeitem").first().focus();
  await page.keyboard.press("F6");
  // Focus is in the page column, outside both panes.
  await expect(page.locator(":focus")).toHaveCount(1);
  await expect(page.locator("aside :focus")).toHaveCount(0);
  await page.keyboard.press("F6");
  await expect(settings).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.getByRole("treeitem").first()).toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(settings).toBeFocused();
});

test("at 1024px the pane opens as an overlay over the page, which Escape closes", async ({
  page,
}) => {
  await openSampleWorld(page, 1024);
  await expect(pane(page)).toBeHidden();

  await button(page).click();
  await expect(pane(page)).toBeVisible();
  // Measure once the slide has ended.
  await expect
    .poll(() => pane(page).evaluate((element) => getComputedStyle(element).translate))
    .toBe("none");
  const overlay = await box(pane(page));
  expect(overlay.x + overlay.width).toBe(1024);
  // It covers the page region instead of narrowing it.
  expect((await box(page.getByRole("main"))).width).toBe(1024 - 264);

  await page.keyboard.press("Escape");
  await expect(pane(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
});

test("the no-provider notice's Settings button opens Settings, where AI off removes the pane", async ({
  page,
}) => {
  await openSampleWorld(page);
  await expect(pane(page)).toContainText("Add a provider in Settings to use the assistant.");

  await pane(page).getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const toggle = settings.getByRole("switch", { name: "AI features" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(button(page)).toHaveCount(0);
  await expect(page.locator('aside[aria-label="Assistant"]')).toHaveCount(0);

  await toggle.click();
  await expect(button(page)).toBeVisible();
  await expect(pane(page)).toBeVisible();
});

// The preview's assistant streams a canned answer about the active page in chunks about 100 ms
// apart, and fails a message `fail:<reason>` for that reason.

/** Opens the sample world, saves a provider in Settings and opens a top-level page. */
async function openWithProvider(page: Page) {
  await openSampleWorld(page);
  await pane(page).getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Base URL").fill("https://api.mistral.ai/v1");
  await settings.getByLabel("Model").fill("mistral-small-latest");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(pane(page)).toContainText("mistral-small-latest");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.getByRole("treeitem", { name: "Campaign overview", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Campaign overview" })).toBeVisible();
}

async function send(page: Page, text: string) {
  const message = pane(page).getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
}

const answer = (page: Page) => pane(page).getByRole("textbox", { name: "Answer" });

test("an answer streams in, and its disclosure lists the active page and opens it", async ({
  page,
}) => {
  await openWithProvider(page);

  await send(page, "What is the steppe like?");

  await expect(pane(page).getByText("What is the steppe like?")).toBeVisible();
  await expect(pane(page).getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(answer(page)).toContainText("The pages I read");
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
  await expect(answer(page)).toContainText("Ask about another page to compare them.");
  await expect(answer(page)).toContainText("[[Campaign overview]]");

  await page.getByRole("treeitem", { name: "Session notes", exact: true }).click();
  await page.getByRole("treeitem", { name: "Session 1", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Session 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await pane(page).getByRole("button", { name: "Read 1 page" }).click();
  await pane(page).getByRole("button", { name: "Campaign overview" }).click();
  await expect(page.getByRole("tab", { name: "Campaign overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Stop keeps the text so far, marked as stopped", async ({ page }) => {
  await openWithProvider(page);

  await send(page, "What is the steppe like?");
  await expect(answer(page)).toContainText("The pages I read");
  await pane(page).getByRole("button", { name: "Stop" }).click();

  await expect(pane(page).getByText("Stopped.", { exact: true })).toBeVisible();
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
  await expect(answer(page)).toContainText("The pages I read");
  await expect(answer(page)).not.toContainText("compare them");
});

test("a rate-limited answer shows a warning with Retry, which answers again", async ({ page }) => {
  await openWithProvider(page);

  await send(page, "fail:rate_limited");

  const notice = pane(page).getByRole("alert");
  await expect(notice).toContainText("The provider is limiting requests. Try again later.");
  await expect(notice).toContainText(
    "The provider's message: Sample message from the provider, with <b>markup</b> shown as text.",
  );
  await notice.getByRole("button", { name: "Retry" }).click();
  // The preview fails the same message again, and its failure replaces the first.
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
  await expect(pane(page).getByRole("alert")).toHaveCount(1);
  await expect(pane(page).getByRole("alert").getByRole("button", { name: "Retry" })).toBeVisible();
});

// The canned answer links [[Brother Ketil]] and [[Kesh Tor]], two pages of the sample world.

test("a page the message links is read, and Ctrl+click on a link in the answer opens its page in a new tab", async ({
  page,
}) => {
  await openWithProvider(page);

  await send(page, "Who keeps the shrine at [[Kesh Tor]]?");
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
  await pane(page).getByRole("button", { name: "Read 2 pages" }).click();
  await expect(pane(page).getByRole("button", { name: "Campaign overview" })).toBeVisible();
  await expect(pane(page).getByRole("button", { name: "Kesh Tor" })).toBeVisible();

  const link = answer(page).locator(".cm-link", { hasText: "[[Kesh Tor]]" });
  await link.click({ modifiers: ["Control"] });

  await expect(page.getByRole("tab", { name: "Kesh Tor" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Campaign overview" })).toBeVisible();
});

test("Copy puts the answer's Markdown on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openWithProvider(page);

  await send(page, "What is the steppe like?");
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
  await pane(page).getByRole("button", { name: "Copy" }).click();

  await expect(pane(page).getByText("Copied", { exact: true })).toBeAttached();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^The pages I read say this about \[\[Campaign overview\]\]:\n\n- /);
  expect(copied).toMatch(
    /\[\[Kesh Tor\]\], the only shade for a day's ride\.\n\nAsk about another page to compare them\.$/,
  );
});
