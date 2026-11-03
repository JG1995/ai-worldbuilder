import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, test } from "@playwright/test";

// Serves the production build from a fake origin with the production content security policy
// from tauri.conf.json, so a styling or asset technique that the policy blocks fails here.
const root = join(import.meta.dirname, "..");
const distDir = join(root, "dist");
const origin = "http://grimoire.test";
const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const policy = tauriConf.app.security.csp as Record<string, string>;

/**
 * The policy and page as Tauri serves them: on every load it gives each `<style>` element of the
 * page a fresh nonce and adds that nonce to `style-src`, keeping the configured sources.
 */
function withStyleNonce(html: string) {
  const nonce = randomUUID().replaceAll("-", "");
  const csp = Object.entries({
    ...policy,
    "style-src": `${policy["style-src"]} 'nonce-${nonce}'`,
  })
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join("; ");
  return { csp, html: html.replaceAll("<style>", `<style nonce="${nonce}">`) };
}

/** A 120 × 160 PNG, the world image the core serves through its scheme. */
const worldImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAIAAABIaz/HAAAA/ElEQVR42u3QQREAEBAAwIvjKYAAAgggiijCCKaC1z3MzmyCjVYLCUKBaNGIFi3agmjRiBYt2oJo0YgWLRrRohEtWjSiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNE8R5+9SCBatGhEixatQLRoRIsWbUG0aESLFm1BtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRItGtGjRiBaNaNGiES0a0aJFI/qL6DE7CUSLFo1o0aIViBaNaNGiLYgWjWjRoi2IFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRP/gAp3PFEved0J+AAAAAElFTkSuQmCC",
  "base64",
);
/** The URL `convertFileSrc` gives the image on Windows, with the stamp `images_resolve` gave it. */
const worldImageUrl = "http://grimoire-image.localhost/1%2FMaps%2FKesh%20map.png?v=7-1700000000";

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

test("the production build renders a page in the editor under the production CSP", async ({
  page,
}) => {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  // The element that carries Tauri's style nonce, which the editor passes to CodeMirror.
  expect(html).toContain("<style></style>");
  const served = withStyleNonce(html);

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { violations });
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
    // A stand-in for the Tauri runtime, so the production bundle reaches a canned core. Event
    // subscriptions are answered by command name, with the callback plumbing `listen` uses, but no
    // event is ever sent.
    let callbacks = 0;
    const responses: Record<string, unknown> = {
      world_restore: null,
      recent_list: [],
      "plugin:event|listen": 1,
      "plugin:event|unlisten": null,
      world_open: {
        name: "Kesh",
        session: 1,
        workspace: { tabs: [], active: null, expanded: [], treeWidth: 264, reading: [] },
      },
      world_tree: [{ path: "Kesh Tor.md", name: "Kesh Tor", kind: "page" }],
      page_read: {
        // Elements whose live preview draws boxes, widgets and fills, which a decoration that
        // needed a blocked style attribute would report as a violation.
        text: [
          "---",
          "title: Kesh Tor",
          "---",
          "# Kesh Tor",
          "",
          "Roll `3d6` at ==dusk==.",
          "",
          "> [!note] Shelter",
          "> A cave.",
          "",
          "- [ ] Bring water",
          "",
          "| Supply | Days |",
          "| --- | ---: |",
          "| Water | 3 |",
          "",
          "![[Kesh map.png]] beside ![a web image](https://example.com/a.png)",
          "",
        ].join("\n"),
        version: "1",
      },
      images_resolve: [
        { state: "found", path: "Maps/Kesh map.png", stamp: "7-1700000000" },
        { state: "web" },
      ],
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => responses[command],
        transformCallback: () => ++callbacks,
        // As Tauri builds a custom scheme's URL on Windows.
        convertFileSrc: (path: string, protocol: string) =>
          `http://${protocol}.localhost/${encodeURIComponent(path)}`,
      },
      // `@tauri-apps/api` calls it before it asks the core to unlisten.
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = join(distDir, path === "/" ? "index.html" : path);
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({
      body: path === "/" ? served.html : readFileSync(file),
      headers: {
        "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
        "Content-Security-Policy": served.csp,
      },
    });
  });

  await page.route("http://grimoire-image.localhost/**", (route) =>
    route.fulfill({ body: worldImage, headers: { "Content-Type": "image/png" } }),
  );

  await page.goto(`${origin}/`);

  await page.getByRole("button", { name: "Open world…" }).click();
  const row = page.getByRole("treeitem", { name: "Kesh Tor" });
  await expect(row.locator(".icon")).toHaveCSS("font-family", '"Material Symbols Sharp"');
  await row.click();
  const editor = page.getByRole("textbox", { name: "Kesh Tor" });
  // Away from the cursor, which starts on the frontmatter's first line, the syntax is hidden.
  await expect(editor).toContainText("Roll 3d6 at dusk.");
  await expect(editor.locator(".cm-highlight")).toHaveText("dusk");
  await expect(editor.locator(".cm-callout-title")).toHaveText("Shelter");
  await expect(editor.getByRole("checkbox", { name: "Bring water" })).toBeVisible();
  await expect(editor.getByRole("table").getByRole("cell")).toHaveText(["Water", "3"]);
  // The world's image loads through the core's scheme; the web image is never asked for.
  const image = editor.locator(".cm-image img");
  await expect(image).toHaveAttribute("alt", "Kesh map");
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);
  await expect(editor.locator(".cm-image-placeholder")).toContainText(
    "Web images are not loaded: https://example.com/a.png",
  );
  // Only CodeMirror's own base theme, in the <style> element that carries the nonce, makes the
  // editor a flex box; the theme's editor section supplies the mono family.
  await expect(page.locator(".cm-editor")).toHaveCSS("display", "flex");
  await expect(editor.locator(".cm-mono", { hasText: "3d6" })).toHaveCSS(
    "font-family",
    /^ui-monospace/,
  );

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

  const violations = () =>
    page.evaluate(() => (window as unknown as { violations: string[] }).violations);
  expect(await violations()).toEqual([]);
  const offOrigin = requests.filter((url) => new URL(url).origin !== origin);
  expect([...new Set(offOrigin)]).toEqual([worldImageUrl]);

  // A <style> element without the nonce, as injected HTML would add, is still blocked.
  const injectedApplies = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "#root { visibility: hidden; }";
    document.head.append(style);
    return getComputedStyle(document.getElementById("root") as HTMLElement).visibility === "hidden";
  });
  expect(injectedApplies).toBe(false);
  await expect.poll(violations).toEqual([expect.stringMatching(/^style-src/)]);
});
