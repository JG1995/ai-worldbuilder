import { invokeCommand } from "@/lib/ipc";
import type { ProviderSaved, Settings } from "@/types/api";

/** The saved settings: whether AI is on, and the saved text provider without its key. */
export const settingsGet = () => invokeCommand<Settings>("settings_get");

/** The TanStack Query key of the saved settings. */
export const settingsGetKey = ["settings_get"] as const;

/**
 * Switches AI features on or off and saves that at once. Rejects with `io` when the settings cannot
 * be saved, and the switch then keeps its state.
 */
export const settingsAiSet = (on: boolean) => invokeCommand<Settings>("settings_ai_set", { on });

/**
 * Saves the text provider. A typed `key` goes to the system keychain, or with `keyFile`, when no
 * keychain can be reached, to the key file; without one, the stored key stays, unless the base
 * URL's origin changes, which removes it. Answers `invalid` for a field that breaks a rule and
 * `no_keychain` when the key needs the user's consent for the key file, each with nothing stored.
 * Rejects with `ai_off` while AI is off, `keychain` when the keychain refuses or fails, and `io`.
 */
export const providerSave = (
  baseUrl: string,
  model: string,
  key: string | null,
  keyFile: boolean,
) => invokeCommand<ProviderSaved>("provider_save", { baseUrl, model, key, keyFile });

/**
 * Deletes the stored key, then records that none is stored. Rejects with `ai_off` while AI is off,
 * and with `keychain` or `io` when the key cannot be deleted, which keeps it recorded.
 */
export const providerKeyRemove = () => invokeCommand<Settings>("provider_key_remove");
