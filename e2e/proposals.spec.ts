import { expect, type Locator, type Page, test } from "@playwright/test";

// The browser preview's assistant (src/lib/preview-fixtures.ts) answers a message starting
// `propose:` with three proposals: a new page Places/Saltmere, an edit of the active page, and a
// new page Characters/Mirela Dask. `propose-fail:` adds an edit of The mirror lake whose write
// always fails. Each test loads the preview afresh, so its world starts as the sample world.

const pane = (page: Page) => page.getByRole("complementary", { name: "Assistant" });
const card = (page: Page, name: string) => pane(page).getByRole("article", { name });
const editor = (page: Page) => page.getByRole("textbox", { name: "Campaign overview" });
const toast = (page: Page) => page.getByRole("status").getByRole("listitem");

const addedLine = "The caravan from [[Saltmere]] stops here on its way north.";

/** Opens the sample world, saves a provider and opens Campaign overview, the active page. */
async function openWithProvider(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree", { name: "The Glass Steppe" })).toBeVisible();
  await pane(page).getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Base URL").fill("https://api.mistral.ai/v1");
  await settings.getByLabel("Model").fill("mistral-small-latest");
  await settings.getByRole("button", { name: "Save" }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.getByRole("treeitem", { name: "Campaign overview", exact: true }).click();
  await expect(editor(page)).toContainText("3d6");
}

/** Sends `text` and waits until the answer has ended. */
async function send(page: Page, text: string) {
  const message = pane(page).getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(pane(page).getByRole("button", { name: "Send" })).toBeVisible();
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element has no box.");
  return found;
}

test("a batch is accepted in part, written to the world, and undone from the pane", async ({
  page,
}) => {
  await openWithProvider(page);
  const tab = page.getByRole("tab", { name: "Campaign overview" });

  await send(page, "propose: Flesh out Saltmere");

  await expect(pane(page).getByText("2 new pages, 1 edit")).toBeVisible();
  const boxes = pane(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(3);
  for (const ticked of await boxes.all()) await expect(ticked).toBeChecked();
  await expect(tab).toHaveAccessibleDescription("Changes waiting for review");
  await pane(page).getByRole("checkbox", { name: "Select Mirela Dask" }).uncheck();
  await pane(page).getByRole("button", { name: "Accept selected" }).click();

  await expect(toast(page)).toContainText("Accepted 2 changes");
  await expect(toast(page).getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(editor(page)).toContainText(addedLine);
  await expect(tab).not.toHaveAccessibleDescription("Changes waiting for review");
  await page.getByRole("treeitem", { name: "Places", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "Saltmere", exact: true })).toBeVisible();
  await expect(card(page, "New page: Saltmere")).toContainText("Accepted");
  // The unticked proposal stays pending.
  await expect(
    card(page, "New page: Mirela Dask").getByRole("button", { name: "Accept" }),
  ).toBeEnabled();

  await pane(page).getByRole("button", { name: "Undo" }).click();

  await expect(editor(page)).not.toContainText(addedLine);
  await expect(page.getByRole("treeitem", { name: "Places", exact: true })).toHaveCount(0);
  await expect(card(page, "Edit: Campaign overview")).toContainText("Undone");
  await expect(tab).toHaveAccessibleDescription("Changes waiting for review");
});

test("a write that fails partway accepts the changes before it, and its card says why", async ({
  page,
}) => {
  await openWithProvider(page);

  await send(page, "propose-fail: Flesh out Saltmere");
  await pane(page).getByRole("button", { name: "Accept selected" }).click();

  await expect(toast(page)).toContainText("Accepted 3 of 4 changes");
  await expect(card(page, "Edit: The mirror lake")).toContainText(
    "This change could not be written: The page is read-only.",
  );
  await expect(card(page, "New page: Mirela Dask")).toContainText("Accepted");
});

test("with AI off no proposal shows, and switching it on shows them in their states", async ({
  page,
}) => {
  await openWithProvider(page);
  const tab = page.getByRole("tab", { name: "Campaign overview" });
  await send(page, "propose: Flesh out Saltmere");
  await card(page, "New page: Mirela Dask").getByRole("button", { name: "Reject" }).click();
  await expect(card(page, "New page: Mirela Dask")).toContainText("Rejected");
  await card(page, "New page: Saltmere").getByRole("button", { name: "Accept" }).click();
  await expect(card(page, "New page: Saltmere")).toContainText("Accepted");

  await page.keyboard.press("Control+Comma");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const toggle = settings.getByRole("switch", { name: "AI features" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await expect(page.getByRole("article", { name: /^(New page|Edit): / })).toHaveCount(0);
  await expect(page.getByText(/Proposing|Accept selected|Undone/)).toHaveCount(0);
  await expect(tab).not.toHaveAccessibleDescription("Changes waiting for review");

  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(card(page, "New page: Saltmere")).toContainText("Accepted");
  await expect(card(page, "New page: Mirela Dask")).toContainText("Rejected");
  await expect(
    card(page, "Edit: Campaign overview").getByRole("button", { name: "Accept" }),
  ).toBeEnabled();
  await expect(tab).toHaveAccessibleDescription("Changes waiting for review");
});

test("checkboxes, Show all, Accept selected and Undo work by keyboard, and focus follows", async ({
  page,
}) => {
  await openWithProvider(page);
  await send(page, "propose: Flesh out Saltmere");

  const mirela = pane(page).getByRole("checkbox", { name: "Select Mirela Dask" });
  await mirela.focus();
  await page.keyboard.press("Space");
  await expect(mirela).not.toBeChecked();
  // The edit's diff holds the whole page, more than 12 lines.
  const showAll = card(page, "Edit: Campaign overview").getByRole("button", { name: "Show all" });
  await showAll.focus();
  await page.keyboard.press("Enter");
  await expect(
    card(page, "Edit: Campaign overview").getByRole("button", { name: "Show less" }),
  ).toHaveAttribute("aria-expanded", "true");
  await pane(page).getByRole("button", { name: "Accept selected" }).focus();
  await page.keyboard.press("Enter");

  const undo = pane(page).getByRole("button", { name: "Undo" });
  await expect(undo).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(card(page, "New page: Saltmere")).toBeFocused();
  await expect(card(page, "New page: Saltmere")).toContainText("Undone");
});

test("at 720px the cards keep their actions inside the pane", async ({ page }) => {
  await openWithProvider(page);
  await send(page, "propose: Flesh out Saltmere");

  await page.setViewportSize({ width: 720, height: 480 });
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(pane(page)).toBeVisible();
  await expect
    .poll(() => pane(page).evaluate((element) => getComputedStyle(element).translate))
    .toBe("none");

  const edge = await box(pane(page));
  const right = edge.x + edge.width;
  expect(right).toBeLessThanOrEqual(720);
  for (const action of [
    pane(page).getByRole("button", { name: "Accept selected" }),
    card(page, "Edit: Campaign overview").getByRole("button", { name: "Accept" }),
    card(page, "Edit: Campaign overview").getByRole("button", { name: "Reject" }),
  ]) {
    await action.scrollIntoViewIfNeeded();
    const button = await box(action);
    expect(button.x).toBeGreaterThanOrEqual(edge.x);
    expect(button.x + button.width).toBeLessThanOrEqual(right);
  }
});
