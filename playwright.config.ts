import { defineConfig, devices } from "@playwright/test";

// The smoke test starts its own preview server on 1421, never reusing one, so it cannot
// attach to a developer's `pnpm dev` or `pnpm tauri dev` server on 1420.
const baseURL = "http://localhost:1421";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: true,
  reporter: "list",
  use: { baseURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev --port 1421 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
  },
});
