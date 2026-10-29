import { expect, test } from "@playwright/test";

test("the browser preview shows the placeholder screen from sample data", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Grimoire.md");
  await expect(page.getByRole("heading", { name: "Grimoire.md" })).toBeVisible();
  await expect(page.getByText("Version 0.0.0-preview.sample-data")).toBeVisible();
});
