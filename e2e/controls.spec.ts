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
