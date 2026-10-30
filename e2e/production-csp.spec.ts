import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, test } from "@playwright/test";

// Serves the production build from a fake origin with the production content security policy
// from tauri.conf.json, so a styling or asset technique that the policy blocks fails here.
const root = join(import.meta.dirname, "..");
const distDir = join(root, "dist");
const origin = "http://grimoire.test";
const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const csp = Object.entries(tauriConf.app.security.csp as Record<string, string>)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");

const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

test.beforeAll(() => {
  if (!existsSync(distDir)) throw new Error("dist/ is missing. Run `pnpm build` first.");
});

test("the production build renders under the production CSP with its bundled fonts", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { violations });
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = join(distDir, path === "/" ? "index.html" : path);
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({
      body: readFileSync(file),
      headers: {
        "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
        "Content-Security-Policy": csp,
      },
    });
  });

  await page.goto(`${origin}/`);

  // Outside Tauri, a production build cannot reach the core and shows the error state.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The version could not be read");
  await expect(alert.locator(".icon")).toHaveCSS("font-family", '"Material Symbols Sharp"');

  for (const [font, text] of [
    ['500 40px "Darker Grotesque"', "G"],
    ['400 14px "Hanken Grotesk"', "T"],
    ['16px "Material Symbols Sharp"', "\u{e000}"],
  ]) {
    const loaded = await page.evaluate(
      async ([font, text]) => {
        const faces = await document.fonts.load(font, text);
        return faces.length > 0 && faces.every((face) => face.status === "loaded");
      },
      [font, text],
    );
    expect(loaded, font).toBe(true);
  }

  expect(
    await page.evaluate(() => (window as unknown as { violations: string[] }).violations),
  ).toEqual([]);
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});
