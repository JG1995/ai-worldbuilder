// The shared Tauri IPC mock for this feature's tests. It answers every command the feature has with
// a default, so a test overrides only the commands it is about.
import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { vi } from "vitest";
import type { TreeEntry } from "../../ui/FileTree";
import type { PageText, WorldOpened } from "./commands";
import { pageNameOf } from "./store";

type Handler = (args: Record<string, unknown>) => unknown;

export const testWorld: WorldOpened = {
  name: "Kesh",
  session: 1,
  workspace: { tabs: [], active: null, expanded: [], treeWidth: 264 },
};

export const testTree: TreeEntry[] = [
  {
    path: "Places",
    name: "Places",
    kind: "folder",
    children: [
      { path: "Places/Kesh Tor.md", name: "Kesh Tor", kind: "page" },
      { path: "Places/Mirror lake.md", name: "Mirror lake", kind: "page" },
    ],
  },
  { path: "Overview.md", name: "Overview", kind: "page" },
];

/** The default location for a new world. */
export const testLocation = "/home/tester/Documents";

const defaults: Record<string, Handler> = {
  world_open: () => testWorld,
  world_close: () => null,
  world_tree: () => testTree,
  page_read: ({ path }): PageText => ({
    text: `# ${pageNameOf(String(path))}\n`,
    version: `version of ${String(path)}`,
  }),
  page_write: ({ path, text }) => ({
    version: `version of ${String(path)} saved as ${String(text)}`,
  }),
  page_create: ({ folder, name }) => ({ path: entryPath(folder, `${String(name)}.md`) }),
  folder_create: ({ folder, name }) => ({ path: entryPath(folder, String(name)) }),
  world_new_location: () => ({ location: testLocation }),
  world_new_browse: () => null,
  world_create: ({ name }): WorldOpened => ({ ...testWorld, name: String(name), session: 2 }),
};

function entryPath(folder: unknown, name: string) {
  return folder === null ? name : `${String(folder)}/${name}`;
}

/** Mocks the core. Returns the calls it receives, in order. */
export function mockWorldIpc(overrides: Record<string, Handler> = {}) {
  const calls: { command: string; args?: InvokeArgs }[] = [];
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC(
    (command, args) => {
      calls.push({ command, args });
      const handler = overrides[command] ?? defaults[command];
      if (!handler) throw `unexpected command ${command}`;
      return handler((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}
