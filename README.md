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
- `pnpm dev` runs the interface alone in a browser preview, answering Rust commands with development-only sample data. It starts on the welcome screen, where Open world… opens a sample world at once, without a folder dialog. The welcome screen lists sample recent worlds, one of them with a missing folder.
- `pnpm tauri dev` runs the desktop application in development mode.
- `pnpm check` runs every check: Biome, `tsc`, secretlint, the production build and its check for sample data, the showcase and inlined assets, Vitest, the Playwright tests, `cargo fmt --check`, `cargo clippy` and `cargo test`. It stops at the first failing check.
- `pnpm icons` rebuilds the bundled icon font and `src/ui/icon-glyphs.ts` from the names in `src/ui/icon-names.json`. It needs [pipx](https://pipx.pypa.io/) and network access, because it fetches fonttools from PyPI.
- `pnpm tauri build` builds unsigned installers for the current OS into `src-tauri/target/release/bundle/`.

In development, `/showcase.html` on the dev server shows the design foundation: the colour, type, spacing and shape tokens, the icons and the logo, and every shared control and surface in its states, with a switch between the OS, dark and light colour modes. `/showcase.html#sample-world` shows the composed sample screen. In development builds, a Showcase link in the top right corner of the welcome screen opens it. Production builds never include it.

## Application data

The application keeps its own data in the `grimoire-data` folder, in the app data folder for `io.github.jg1995.grimoire`:

- Linux: `~/.local/share/io.github.jg1995.grimoire/grimoire-data/`
- Windows: `%APPDATA%\io.github.jg1995.grimoire\grimoire-data\`
- macOS: `~/Library/Application Support/io.github.jg1995.grimoire/grimoire-data/`

`worlds.json` holds the recent worlds, the world that was open when the application last closed, and each recent world's open tabs, expanded folders and file tree width. It never holds page text. If the file is deleted or cannot be read, the application starts with an empty recent list and replaces the file the next time it saves.

`history/` holds one SQLite database per world, named by a hash of the world folder's path. It records every change the application makes to the world, with copies of the text of the pages it changed: the changes of the last 90 days, and at least the world's 100 most recent changes, whatever their age. Older changes are removed when the world opens. A world's history is kept when the world leaves the recent list, and it does not move with the world folder: a world opened from a new path starts an empty history. A damaged database is renamed with `.damaged-` and the time appended, and kept beside the new one.

`index/` holds a cache of each world's pages, aliases and links, and a copy of each page's text for search, one SQLite database per world, named like its history. It only repeats what the world's files hold: the application rebuilds it when it is deleted, damaged or from another version, and deleting it loses nothing.

On Linux, the webview keeps its own caches at the root of the same app data folder. The application writes nothing into a world folder except the pages and folders you create or edit.

## Continuous integration and releases

GitHub Actions runs two workflows:

- **Check** runs `pnpm check (Ubuntu)`, the full `pnpm check`, on every pull request and every push to `main`. `Rust checks (Windows)` builds the frontend and runs `cargo fmt --check`, `cargo clippy` and `cargo test`; it runs only on pushes to `main`, not on pull requests. Changes to Markdown files alone run neither job. You can also start the workflow by hand from the Actions tab.
- **Release** builds Windows, Linux and macOS installers. It runs only for version tags, or when you start it by hand from the Actions tab. A manual run on a branch creates no release and keeps the installers as workflow artifacts, so you can test the installers without releasing anything.

Merging to `main` never creates a release.

To make a draft release:

1. Set the new version in `package.json` and `src-tauri/Cargo.toml`, run `pnpm check` so `src-tauri/Cargo.lock` follows, and merge the change to `main`.
2. Tag that commit with `v` followed by the version, and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The Release workflow checks that the tag matches the version in `package.json` and fails without creating a release when it does not. Otherwise it attaches the unsigned installers to a draft GitHub release.

Drafts stay unpublished until the maintainer reviews and publishes them on GitHub.
