import { expect, type Locator, type Page, test } from "@playwright/test";

const accentDark = "rgb(158, 223, 224)";

async function openShowcase(page: Page) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/showcase.html");
  await expect(page.getByRole("heading", { name: "Grimoire.md showcase" })).toBeVisible();
}

function outline(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`;
  });
}

async function openDeleteDialog(page: Page) {
  await page.getByRole("button", { name: "Delete page…" }).click();
  return page.getByRole("dialog", { name: 'Delete "Saltmere"?' });
}

test("a button shows the accent focus ring after Tab and none after a click", async ({ page }) => {
  await openShowcase(page);
  const button = page.getByRole("button", { name: "Open world…" }).first();

  // Clicking the section heading puts the sequential focus starting point just before the button.
  await page.getByRole("heading", { name: "Buttons", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  expect(await outline(button)).toBe(`2px solid ${accentDark}`);

  await page.getByRole("button", { name: "New world…" }).first().click();
  await button.click();
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
});

test("Tab and Shift+Tab cycle inside an open dialog", async ({ page }) => {
  await openShowcase(page);
  const dialog = await openDeleteDialog(page);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const remove = dialog.getByRole("button", { name: 'Delete "Saltmere"' });

  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(remove).toBeFocused();
});

test("a click on the dialog's own content keeps focus, Tab and Escape in the dialog", async ({
  page,
}) => {
  await openShowcase(page);
  const opener = page.getByRole("button", { name: "Delete page…" });
  const dialog = await openDeleteDialog(page);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const remove = dialog.getByRole("button", { name: 'Delete "Saltmere"' });
  const inDialog = () => dialog.evaluate((element) => element.contains(document.activeElement));

  await dialog.getByRole("heading").click();
  expect(await dialog.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  await page.keyboard.press("Shift+Tab");
  await expect(remove).toBeFocused();

  // The bottom padding, below the buttons.
  const box = await dialog.boundingBox();
  if (!box) throw new Error("The dialog has no box.");
  await page.mouse.click(box.x + 8, box.y + box.height - 4);
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();

  await page.mouse.click(box.x + 8, box.y + box.height - 4);
  expect(await inDialog()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("a click outside a menu closes it and returns focus to its opener", async ({ page }) => {
  await openShowcase(page);
  const row = page.getByRole("button", { name: "Saltmere", exact: true });
  const menuButton = page.getByRole("button", { name: "World actions" });
  const blank = page.getByRole("heading", { name: "Menu", exact: true });

  await row.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Page actions" })).toBeVisible();
  await blank.click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(row).toBeFocused();

  await menuButton.click();
  await expect(page.getByRole("menu", { name: "World actions" })).toBeVisible();
  await blank.click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(menuButton).toBeFocused();
});

test("a click outside a menu only closes it, and a right-click outside still opens a menu", async ({
  page,
}) => {
  await openShowcase(page);
  const row = page.getByRole("button", { name: "Saltmere", exact: true });
  const menuButton = page.getByRole("button", { name: "World actions" });
  const deletePage = page.getByRole("button", { name: "Delete page…" });
  const dialog = page.getByRole("dialog");

  await row.click({ button: "right" });
  await deletePage.click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();

  await deletePage.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(deletePage).toBeFocused();

  await row.click({ button: "right" });
  await menuButton.click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(row).toBeFocused();

  // A press released somewhere else leaves the next click working.
  await row.click({ button: "right" });
  const box = await deletePage.boundingBox();
  if (!box) throw new Error("The button has no box.");
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + 4);
  await page.mouse.up();
  await expect(page.getByRole("menu")).toBeHidden();
  await deletePage.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");

  await menuButton.click();
  await row.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Page actions" })).toBeVisible();
});

test("a click on a menu item activates it, and the menu button toggles its menu", async ({
  page,
}) => {
  await openShowcase(page);
  const menuButton = page.getByRole("button", { name: "World actions" });
  const menu = page.getByRole("menu", { name: "World actions" });

  await menuButton.click();
  await menu.getByRole("menuitem", { name: "New folder" }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByText("Chosen: new-folder")).toBeVisible();
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await expect(menu).toBeVisible();
  await menuButton.click();
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();
});

test("a click on a menu's padding or divider keeps it open and working", async ({ page }) => {
  await openShowcase(page);
  const row = page.getByRole("button", { name: "Saltmere", exact: true });
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Page actions" });
  const item = (name: string) => menu.getByRole("menuitem", { name: new RegExp(`^${name}`) });
  await expect(item("Open in new tab")).toBeFocused();

  await menu.click({ position: { x: 20, y: 2 } });
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(item("Rename")).toBeFocused();

  await menu.locator("hr").click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(item("Reveal in file manager")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(row).toBeFocused();
});

test("a toast pushed while a dialog is open is in front of the backdrop", async ({ page }) => {
  await openShowcase(page);
  await openDeleteDialog(page);

  // The backdrop covers the push button, so the click is dispatched to it directly.
  await page.getByRole("button", { name: "Push a toast", exact: true }).dispatchEvent("click");
  const toast = page.getByRole("status").getByRole("listitem");
  await expect(toast).toBeVisible();

  const box = await toast.boundingBox();
  if (!box) throw new Error("The toast has no box.");
  const onTop = await toast.evaluate(
    (element, [x, y]) => element.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(onTop).toBe(true);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`menus and dialogs fade in unless motion is reduced: ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await openShowcase(page);
    const expected = reducedMotion === "reduce" ? "0s" : "0.12s";
    const duration = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).transitionDuration);

    await page.getByRole("button", { name: "World actions" }).click();
    const menu = page.getByRole("menu", { name: "World actions" });
    expect(await duration(menu)).toBe(expected);
    await page.keyboard.press("Escape");

    const dialog = await openDeleteDialog(page);
    // The fade is on the backdrop layer that holds the dialog.
    expect(await duration(dialog.locator(".."))).toBe(expected);
  });
}

test("every button variant keeps a visible border and its height under forced colours", async ({
  page,
}) => {
  await openShowcase(page);
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Buttons", exact: true }),
  });
  const buttons = [
    section.getByRole("button", { name: "Open world…" }).first(),
    section.getByRole("button", { name: "New page" }).first(),
    section.getByRole("button", { name: 'Delete "Saltmere"' }).first(),
    section.getByRole("button", { name: "Close tab" }),
  ];
  const height = async (button: Locator) => (await button.boundingBox())?.height;
  const normalHeights = await Promise.all(buttons.map(height));

  await page.emulateMedia({ forcedColors: "active" });
  for (const [index, button] of buttons.entries()) {
    const border = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.borderTopStyle, width: Number.parseFloat(style.borderTopWidth) };
    });
    expect(border.style).not.toBe("none");
    expect(border.width).toBeGreaterThanOrEqual(1);
    expect(await height(button)).toBe(normalHeights[index]);
  }
});
