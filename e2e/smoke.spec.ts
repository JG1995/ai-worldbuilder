import { expect, test } from "@playwright/test";

test("the browser preview launches on the welcome screen with its recent worlds", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Grimoire.md");
  await expect(page.getByRole("img", { name: "Grimoire.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open world…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New world…" })).toBeVisible();
  const recent = page.getByRole("region", { name: "Recent worlds" }).getByRole("listitem");
  await expect(recent).toHaveCount(3);
  await expect(recent.first()).toContainText("The Glass Steppe");
  await expect(recent.last()).toContainText("The Sunken Archive");
  await expect(recent.last()).toContainText("Not found");
  await expect(recent.last().getByRole("button", { name: "Remove" })).toBeVisible();
});
