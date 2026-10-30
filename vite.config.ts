/// <reference types="vitest/config" />
import process from "node:process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;
const showcaseDir = normalizePath(fileURLToPath(new URL("./src/showcase/", import.meta.url)));

// The showcase and its sample data are development-only. This fails the production build when
// any of their modules enters it, whether or not tree-shaking would have removed it later.
const excludeShowcase: Plugin = {
  name: "exclude-showcase",
  apply: "build",
  enforce: "pre",
  transform(_code, id) {
    if (normalizePath(id).startsWith(showcaseDir)) {
      this.error(`Showcase module in the production build: ${id}`);
    }
  },
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), excludeShowcase],

  // Emit every font and image as a file: the production CSP blocks inlined data: URLs.
  build: { assetsInlineLimit: 0 },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    clearMocks: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "ui",
          include: ["src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["src/test/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "config",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
}));
