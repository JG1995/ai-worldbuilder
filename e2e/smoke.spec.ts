import { expect, test } from "@playwright/test";

test("the browser preview launches on the welcome screen", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Grimoire.md");
  await expect(page.getByRole("img", { name: "Grimoire.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open world…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New world…" })).toBeVisible();
  await expect(page.getByText("No worlds yet.")).toBeVisible();
});
