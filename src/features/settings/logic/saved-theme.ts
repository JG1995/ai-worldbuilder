import type { QueryClient } from "@tanstack/react-query";
import type { IpcError } from "@/lib/ipc";
import type { Settings, Theme } from "@/types/api";
import { applyTheme } from "@/ui/themes";
import { settingsGet, settingsGetKey, settingsThemeSet } from "../api/commands";

/** The theme the window shows, and why the last choice could not be saved, if it could not. */
export type ThemeState = { shown: Theme; failure: string | null };

// The theme lives here rather than in the Settings dialog, so a save in flight when the dialog
// closes still finishes, and a reopened dialog checks the theme that is shown.
let state: ThemeState = { shown: "saturn-seal", failure: null };
/** The theme the core holds, which a failed save returns to. */
let saved: Theme = "saturn-seal";
/** The latest choice not yet sent; only one save runs at a time. */
let wanted: Theme | null = null;
let saving = false;
const listeners = new Set<() => void>();

function update(next: Partial<ThemeState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** The current state; the same object until it changes. */
export const themeState = () => state;

/** Calls `listener` after each change of the state until the returned function is called. */
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies the saved theme. Saturn Seal applies when the settings cannot be read, so it never
 * rejects and the application can start.
 */
export async function applySavedTheme() {
  let theme: Theme = "saturn-seal";
  try {
    theme = (await settingsGet()).theme;
  } catch {
    // A failed call or a missing answer starts in Saturn Seal, as the default AI setting does.
  }
  saved = theme;
  applyTheme(theme);
  update({ shown: theme });
}

/**
 * Shows `theme` at once and saves it. A save waits for the one running, and only the latest choice
 * is sent next. A failed save returns the window to the saved theme and drops any later choice.
 */
export function chooseTheme(queryClient: QueryClient, theme: Theme) {
  if (theme === state.shown) return;
  applyTheme(theme);
  wanted = theme;
  update({ shown: theme });
  if (!saving) void saveWanted(queryClient);
}

async function saveWanted(queryClient: QueryClient) {
  saving = true;
  while (wanted !== null) {
    const theme = wanted;
    wanted = null;
    try {
      const answer = await settingsThemeSet(theme);
      saved = answer.theme;
      // Only the theme: a provider saved meanwhile stays in the cache.
      queryClient.setQueryData<Settings>(
        settingsGetKey,
        (cached) => cached && { ...cached, theme: answer.theme },
      );
      update({ failure: null });
    } catch (error) {
      wanted = null;
      applyTheme(saved);
      update({
        shown: saved,
        failure: `The setting could not be saved: ${(error as IpcError).message}`,
      });
    }
  }
  saving = false;
}

/** Returns to Saturn Seal with nothing saved or pending. For tests only. */
export function resetTheme() {
  state = { shown: "saturn-seal", failure: null };
  saved = "saturn-seal";
  wanted = null;
  saving = false;
  applyTheme("saturn-seal");
}
