import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { applySavedTheme, resetTheme, themeState } from "./saved-theme";

afterEach(resetTheme);

/** Answers `settings_get` with `answer`, or rejects it when `answer` is an error. */
function answerSettings(answer: unknown) {
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC((command) => {
    if (command !== "settings_get") throw `unexpected command ${command}`;
    if (answer instanceof Error) throw { kind: "io", message: answer.message };
    return answer;
  });
}

it("applies the saved theme", async () => {
  answerSettings({ ai: true, textProvider: null, imageProvider: null, theme: "lamplight" });

  await applySavedTheme();

  expect(document.documentElement.dataset.theme).toBe("lamplight");
  expect(themeState().shown).toBe("lamplight");
});

it.each([
  ["the settings cannot be read", new Error("Permission denied.")],
  ["the answer is missing", undefined],
])("starts in Saturn Seal when %s", async (_, answer) => {
  document.documentElement.dataset.theme = "bound";
  answerSettings(answer);

  await applySavedTheme();

  expect(document.documentElement).not.toHaveAttribute("data-theme");
  expect(themeState().shown).toBe("saturn-seal");
});
