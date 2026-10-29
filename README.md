# AI Worldbuilder

A solo hobby project: **Grimoire.md**, a desktop application for worldbuilding in plain Markdown files. It is built with Tauri 2, React 19 and a Rust core.

## Prerequisites

The repository pins its toolchain: Node 24 (`.nvmrc` and `engines` in `package.json`), pnpm 11.17.0 (`packageManager` in `package.json`) and Rust 1.97.1 with `rustfmt` and `clippy` (`rust-toolchain.toml`). `pnpm install` stops with an error under any Node version other than 24.

### WSL (development)

1. Node 24, for example with `nvm install 24`.
2. pnpm 11, for example with `corepack enable`, which picks up the version from `package.json`.
3. Rust through [rustup](https://rustup.rs/). The pinned toolchain installs itself on the first `cargo` command in the repository.
4. The Tauri Linux libraries:

   ```sh
   sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
     libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```

5. WSLg, which current WSL versions include, so that `pnpm tauri dev` can open a window.
6. After `pnpm install`, the Playwright browser for the smoke test: `pnpm exec playwright install chromium`.

### Windows (building and daily use)

1. Node 24 and pnpm 11 (for example `corepack enable`).
2. Rust through [rustup](https://rustup.rs/).
3. Microsoft C++ Build Tools with the "Desktop development with C++" workload.
4. WebView2, which Windows 10 (version 1803 and later) and Windows 11 already include.

Build Windows installers from a separate clone of the repository on the Windows file system. Do not build from the WSL checkout through `\\wsl$`.

## Commands

- `pnpm install` installs dependencies.
- `pnpm dev` runs the interface alone in a browser preview, answering Rust commands with development-only sample data.
- `pnpm tauri dev` runs the desktop application in development mode.
- `pnpm check` runs every check: Biome, `tsc`, secretlint, the production build and its sample-data check, Vitest, the Playwright smoke test, `cargo fmt --check`, `cargo clippy` and `cargo test`. It stops at the first failing check.
- `pnpm tauri build` builds unsigned installers for the current OS into `src-tauri/target/release/bundle/`.
