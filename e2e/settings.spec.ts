import { expect, type Page, test } from "@playwright/test";

// The browser preview's settings in src/lib/preview-fixtures.ts start with AI on and no provider.

async function openFromWelcome(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Settings" });
  await button.click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  return { button, settings };
}

test("switching AI off leaves only the switch, and switching it on brings the provider back", async ({
  page,
}) => {
  const { settings } = await openFromWelcome(page);
  const toggle = settings.getByRole("switch", { name: "AI features" });
  await expect(toggle).toBeFocused();
  await expect(settings.getByLabel("Base URL")).toBeVisible();

  await page.keyboard.press("Space");

  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByText("Off", { exact: true })).toBeVisible();
  await expect(settings.getByLabel("Base URL")).toHaveCount(0);

  await toggle.click();
  await expect(settings.getByLabel("Base URL")).toBeVisible();
});

test("saving a provider shows where its key is stored, and Escape returns focus", async ({
  page,
}) => {
  const { button, settings } = await openFromWelcome(page);

  await settings.getByLabel("Base URL").fill("https://openrouter.ai/api/v1/");
  await settings.getByLabel("Model").fill("anthropic/claude-sonnet-4.5");
  await settings.getByLabel("API key").fill("sk-preview");
  await settings.getByRole("button", { name: "Save" }).click();

  const key = settings.getByLabel("API key");
  await expect(key).toHaveAccessibleDescription(
    "Stored in the system keychain. Sent only to openrouter.ai.",
  );
  await expect(key).toHaveValue("");
  await expect(key).toBeFocused();
  await expect(settings.getByLabel("Base URL")).toHaveValue("https://openrouter.ai/api/v1");

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("without a keychain, the key is stored in a file only after the warning", async ({ page }) => {
  const { settings } = await openFromWelcome(page);
  await settings.getByLabel("Base URL").fill("https://openrouter.ai/api/v1");
  await settings.getByLabel("Model").fill("anthropic/claude-sonnet-4.5");
  // The preview's stand-in for a computer without a keychain.
  await settings.getByLabel("API key").fill("no-keychain");

  await settings.getByRole("button", { name: "Save" }).click();
  const warning = settings.getByRole("alert");
  await expect(warning).toContainText("No system keychain is available");
  await warning.getByRole("button", { name: "Store in a file" }).click();

  await expect(settings.getByLabel("API key")).toHaveAccessibleDescription(
    "Stored in a file only your account can read. Sent only to openrouter.ai.",
  );
  await expect(settings.getByRole("alert")).toHaveCount(0);
});

test("Ctrl+, opens Settings from a world", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open world…" }).click();
  await expect(page.getByRole("tree")).toBeVisible();

  await page.keyboard.press("Control+Comma");

  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});
