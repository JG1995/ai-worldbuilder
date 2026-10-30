import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const readText = (path: string) => readFileSync(new URL(path, root), "utf8");
const readJson = (path: string) => JSON.parse(readText(path));

const tauriConf = readJson("src-tauri/tauri.conf.json");
const packageJson = readJson("package.json");
const cargoToml = readText("src-tauri/Cargo.toml");

describe("production content security policy", () => {
  const csp: Record<string, string> = tauriConf.app.security.csp;

  it("allows only the application bundle by default", () => {
    expect(csp["default-src"]).toBe("'self'");
  });

  it("allows no outside origin except Tauri IPC in connect-src", () => {
    for (const [directive, sources] of Object.entries(csp)) {
      const origins = sources.split(/\s+/).filter((source) => /^https?:/.test(source));
      const allowed = directive === "connect-src" ? ["http://ipc.localhost"] : [];
      expect(origins, directive).toEqual(allowed);
    }
  });

  it("never allows evaluating strings as code", () => {
    expect(JSON.stringify(csp)).not.toContain("unsafe-eval");
  });
});

describe("permissions", () => {
  it("grants the main window Tauri's core defaults only", () => {
    const files = readdirSync(new URL("src-tauri/capabilities/", root));
    expect(files).toEqual(["default.json"]);

    const capability = readJson("src-tauri/capabilities/default.json");
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(["core:default"]);
  });

  it("configures no Tauri plugins", () => {
    expect(tauriConf.plugins ?? {}).toEqual({});
    expect(cargoToml).not.toMatch(/^tauri-plugin-/m);
  });
});

describe("identity and window", () => {
  it("names the product Grimoire.md with its fixed identifier", () => {
    expect(tauriConf.productName).toBe("Grimoire.md");
    expect(tauriConf.mainBinaryName).toBe("grimoire");
    expect(tauriConf.identifier).toBe("io.github.jg1995.grimoire");
  });

  it("opens one main window titled Grimoire.md at 1280 × 800 with a 720 × 480 minimum", () => {
    expect(tauriConf.app.windows).toEqual([
      expect.objectContaining({
        label: "main",
        title: "Grimoire.md",
        width: 1280,
        height: 800,
        minWidth: 720,
        minHeight: 480,
      }),
    ]);
  });

  it("takes the version from package.json and matches it in Cargo.toml", () => {
    expect(tauriConf.version).toBe("../package.json");
    const cargoVersion = cargoToml.match(/^\[package\][^[]*^version = "([^"]+)"/m)?.[1];
    expect(cargoVersion).toBe(packageJson.version);
  });
});

describe("bundled licence texts", () => {
  const licences = {
    "darker-grotesque-OFL.txt": [
      "SIL Open Font License, Version 1.1",
      "Copyright 2019 The Darker Grotesque Project Authors",
    ],
    "hanken-grotesk-OFL.txt": [
      "SIL Open Font License, Version 1.1",
      "Copyright 2021 The Hanken Grotesk Project Authors",
    ],
    "material-symbols-LICENSE.txt": ["Apache License", "Version 2.0"],
  };

  it("ships exactly the three licence texts under licenses/", () => {
    expect(tauriConf.bundle.resources).toEqual(
      Object.fromEntries(
        Object.keys(licences).map((file) => [`../src/assets/licenses/${file}`, `licenses/${file}`]),
      ),
    );
  });

  it.each(Object.entries(licences))("keeps %s with its licence text", (file, phrases) => {
    const text = readText(`src/assets/licenses/${file}`);
    for (const phrase of phrases) {
      expect(text).toContain(phrase);
    }
  });
});

describe("Rust core", () => {
  it("has no HTTP client dependency", () => {
    expect(cargoToml).not.toMatch(/^(reqwest|hyper|ureq|isahc|surf|attohttpc|curl)\b/m);
  });

  it("never aborts on panic, so command panics become errors", () => {
    expect(cargoToml).not.toMatch(/^panic\s*=\s*"abort"/m);
  });
});
