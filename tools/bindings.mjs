// Regenerates src/types/generated/ from the Rust types (`pnpm bindings`): ts-rs writes one file per
// type when its export tests run. The folder is cleared first, so a type removed in Rust leaves no
// stale file. With --check (`pnpm check:bindings`), it fails when the files were out of date, and
// leaves the regenerated ones in place to review and commit. It needs dist/ (`pnpm build`), because
// Tauri's code generation fails without it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const generatedDir = join(root, "src/types/generated");

/** @returns {Map<string, string>} each file's name and contents */
function snapshot() {
  if (!existsSync(generatedDir)) return new Map();
  return new Map(
    readdirSync(generatedDir).map((name) => [name, readFileSync(join(generatedDir, name), "utf8")]),
  );
}

const before = snapshot();
rmSync(generatedDir, { recursive: true, force: true });
execFileSync(
  "cargo",
  ["test", "--manifest-path", "src-tauri/Cargo.toml", "--quiet", "export_bindings"],
  { cwd: root, stdio: "inherit" },
);
const after = snapshot();

if (process.argv.includes("--check")) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = names.filter((name) => before.get(name) !== after.get(name));
  if (changed.length > 0) {
    console.error(
      `src/types/generated/ was out of date: ${changed.join(", ")}. It is regenerated now; review and commit it.`,
    );
    process.exit(1);
  }
  console.log(`src/types/generated/ matches the Rust types (${after.size} files).`);
}
