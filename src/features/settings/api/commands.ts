import { invokeCommand } from "@/lib/ipc";
import type { ImageTestOutcome, ProviderSaved, Settings, TestOutcome, Theme } from "@/types/api";

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
 * Saves the theme at once. Rejects with `io` when the settings cannot be saved, and the saved theme
 * then stays as it was.
 */
export const settingsThemeSet = (theme: Theme) =>
  invokeCommand<Settings>("settings_theme_set", { theme });

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

/**
 * Sends one test request to the saved provider. Answers `cancelled` when the test was abandoned
 * meanwhile, and `failed` with the reason otherwise. Rejects with `ai_off` while AI is off,
 * `not_found` without a saved provider and `conflict` while another test runs.
 */
export const providerTest = () => invokeCommand<TestOutcome>("provider_test");

/** Abandons a running test, whose result is then discarded. */
export const providerTestCancel = () => invokeCommand<null>("provider_test_cancel");

/**
 * Saves the image provider. A typed `key` goes to the system keychain under the image key's own
 * entry, or with `keyFile`, when no keychain can be reached, to the key file; without one, the
 * stored key stays. Answers `invalid` for a missing model, or a missing key when none is stored,
 * and `no_keychain` when the key needs the user's consent for the key file, each with nothing
 * stored. Rejects with `ai_off` while AI is off, `keychain` when the keychain refuses or fails, and
 * `io`.
 */
export const imageProviderSave = (model: string, key: string | null, keyFile: boolean) =>
  invokeCommand<ProviderSaved>("image_provider_save", { model, key, keyFile });

/**
 * Deletes the stored image key, then records that none is stored; the text provider's key stays.
 * Rejects with `ai_off` while AI is off, and with `keychain` or `io` when the key cannot be deleted.
 */
export const imageProviderKeyRemove = () => invokeCommand<Settings>("image_provider_key_remove");

/**
 * Asks OpenRouter whether it accepts the saved image key and lists the saved model, without
 * generating an image. Answers `cancelled` when the test was abandoned meanwhile, and `failed` with
 * the reason otherwise. Rejects with `ai_off` while AI is off, `not_found` without a saved model
 * and key, and `conflict` while another image test runs.
 */
export const imageProviderTest = () => invokeCommand<ImageTestOutcome>("image_provider_test");

/** Abandons a running image provider test, whose result is then discarded. */
export const imageProviderTestCancel = () => invokeCommand<null>("image_provider_test_cancel");
