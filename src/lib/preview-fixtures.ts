// Sample command results for the browser preview (`pnpm dev`). Development builds only:
// `ipc.ts` loads this module behind `import.meta.env.DEV`, and `tools/check-dist.mjs`
// fails the check if the preview version below appears in a production bundle.
export const previewFixtures: Record<string, unknown> = {
  app_info: { name: "Grimoire.md", version: "0.0.0-preview.sample-data" },
};
