import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderSaved,
  Settings as SavedSettings,
  TestFailure,
  TestOutcome,
  TextProvider,
} from "@/types/api";
import { glyphs } from "@/ui/icon-glyphs";
import { Settings } from "./Settings";

type Handler = (args: Record<string, unknown>) => unknown;

const BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = "anthropic/claude-sonnet-4.5";

const provider = (key: TextProvider["key"]): TextProvider => ({
  baseUrl: BASE_URL,
  model: MODEL,
  key,
  host: "openrouter.ai",
});

const withKey: SavedSettings = { ai: true, textProvider: provider("keychain") };
const empty: SavedSettings = { ai: true, textProvider: null };
const saved = (settings: SavedSettings): ProviderSaved => ({ state: "saved", settings });

const keychainLine = "Stored in the system keychain. Sent only to openrouter.ai.";
const fileLine = "Stored in a file only your account can read. Sent only to openrouter.ai.";
const saveFirst = "Save your changes to test the connection.";
const keyFileWarning =
  "No system keychain is available, so the key cannot be stored there. Grimoire.md can store it in a file in its data folder that only your user account can read. Anyone who can use your account or read your backups can read the key.";

/** Mocks the core with `settings_get` answering `settings` and the other commands from `handlers`. */
function renderSettings(settings: SavedSettings, handlers: Record<string, Handler> = {}) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC((command, args) => {
    const record = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, args: record });
    if (command === "settings_get") return settings;
    const handler = handlers[command];
    if (!handler) throw `unexpected command ${command}`;
    return handler(record);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      {open && <Settings onClose={onClose} />}
    </QueryClientProvider>
  );
  const { rerender } = render(ui(true));
  return {
    calls,
    onClose,
    reopen() {
      rerender(ui(false));
      rerender(ui(true));
    },
  };
}

const dialog = () => screen.findByRole("dialog", { name: "Settings" });
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save" });

function type(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}

describe("Settings", () => {
  it("shows the saved provider and where its key is stored, with Save unavailable", async () => {
    renderSettings(withKey);
    await dialog();

    expect(screen.getByRole("switch", { name: "AI features" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(field("Base URL")).toHaveValue(BASE_URL);
    expect(field("Model")).toHaveValue(MODEL);
    expect(field("API key")).toHaveValue("");
    expect(field("API key")).toHaveAttribute("type", "password");
    expect(field("API key")).toHaveAccessibleDescription(keychainLine);
    expect(save()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeInTheDocument();
  });

  it("hides the provider when AI is switched off, and keeps the switch when that fails", async () => {
    let fail = false;
    const { calls } = renderSettings(withKey, {
      settings_ai_set: ({ on }) => {
        if (fail) throw { kind: "io", message: "Permission denied." };
        return { ...withKey, ai: on };
      },
    });
    const toggle = within(await dialog()).getByRole("switch", { name: "AI features" });

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ command: "settings_ai_set", args: { on: false } });

    fail = true;
    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied.");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("shows a field's rule under it", async () => {
    renderSettings(empty, {
      provider_save: () => ({
        state: "invalid",
        field: "base_url",
        message: "Leave /chat/completions out of the address; Grimoire.md adds it.",
      }),
    });
    await dialog();

    type("Base URL", `${BASE_URL}/chat/completions`);
    type("Model", MODEL);
    fireEvent.click(save());

    await waitFor(() => expect(field("Base URL")).toBeInvalid());
    expect(field("Base URL")).toHaveAccessibleDescription(
      "Leave /chat/completions out of the address; Grimoire.md adds it.",
    );
  });

  it("saves a key to the keychain, empties the key field and moves focus to it", async () => {
    const { calls, onClose } = renderSettings(empty, {
      provider_save: () => saved(withKey),
    });
    await dialog();

    type("Base URL", BASE_URL);
    type("Model", MODEL);
    type("API key", "sk-secret");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(field("API key")).toHaveAttribute("type", "text");
    fireEvent.click(save());

    await waitFor(() => expect(field("API key")).toHaveAccessibleDescription(keychainLine));
    expect(calls.at(-1)).toEqual({
      command: "provider_save",
      args: { baseUrl: BASE_URL, model: MODEL, key: "sk-secret", keyFile: false },
    });
    expect(field("API key")).toHaveValue("");
    expect(field("API key")).toHaveAttribute("type", "password");
    expect(save()).toBeDisabled();
    expect(field("API key")).toHaveFocus();

    fireEvent.keyDown(field("API key"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks before storing the key in a file, and Store in a file stores it there", async () => {
    const { calls } = renderSettings(empty, {
      provider_save: ({ keyFile }) =>
        keyFile ? saved({ ai: true, textProvider: provider("file") }) : { state: "no_keychain" },
    });
    await dialog();
    type("Base URL", BASE_URL);
    type("Model", MODEL);
    type("API key", "sk-secret");

    fireEvent.click(save());

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(keyFileWarning);
    fireEvent.click(within(warning).getByRole("button", { name: "Store in a file" }));

    await waitFor(() => expect(field("API key")).toHaveAccessibleDescription(fileLine));
    expect(calls.at(-1)?.args).toEqual({
      baseUrl: BASE_URL,
      model: MODEL,
      key: "sk-secret",
      keyFile: true,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(field("API key")).toHaveFocus();
  });

  it("stores nothing when the key file is cancelled, and keeps what was typed", async () => {
    const { calls } = renderSettings(empty, { provider_save: () => ({ state: "no_keychain" }) });
    await dialog();
    type("Base URL", BASE_URL);
    type("Model", MODEL);
    type("API key", "sk-secret");
    fireEvent.click(save());

    const warning = await screen.findByRole("alert");
    fireEvent.click(within(warning).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.filter(({ command }) => command === "provider_save")).toHaveLength(1);
    expect(field("Base URL")).toHaveValue(BASE_URL);
    expect(field("API key")).toHaveValue("sk-secret");
    await waitFor(() => expect(field("API key")).toHaveFocus());
  });

  it("explains a keychain that refuses the key", async () => {
    renderSettings(empty, {
      provider_save: () => {
        throw { kind: "keychain", message: "The system keychain is locked or refused access." };
      },
    });
    await dialog();
    type("Base URL", BASE_URL);
    type("Model", MODEL);
    type("API key", "sk-secret");

    fireEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The key could not be stored in the system keychain: The system keychain is locked or refused access.",
    );
  });

  it("says the stored key will be removed when the base URL's origin changes", async () => {
    renderSettings(withKey);
    await dialog();
    const note = "The stored key is for openrouter.ai and will be removed when you save.";

    type("Base URL", "https://openrouter.ai/api/v2");
    expect(field("API key")).toHaveAccessibleDescription(keychainLine);

    type("Base URL", "https://example.com/v1");
    expect(field("API key")).toHaveAccessibleDescription(`${keychainLine} ${note}`);

    type("API key", "sk-new");
    expect(field("API key")).toHaveAccessibleDescription(keychainLine);
  });

  it("removes the key after a confirmation with Cancel focused", async () => {
    const { calls } = renderSettings(withKey, {
      provider_key_remove: () => ({ ai: true, textProvider: provider("none") }),
    });
    await dialog();

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove the API key?" });
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Remove key" }));

    await waitFor(() =>
      expect(field("API key")).toHaveAccessibleDescription(
        "No key is stored. Requests are sent without one.",
      ),
    );
    expect(calls.at(-1)?.command).toBe("provider_key_remove");
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
    expect(field("API key")).toHaveFocus();
  });

  it("offers Test connection only for a saved provider without unsaved edits", async () => {
    renderSettings(empty);
    await dialog();
    const test = screen.getByRole("button", { name: "Test connection" });
    expect(test).toBeDisabled();
    expect(screen.queryByText(saveFirst)).not.toBeInTheDocument();

    type("Base URL", BASE_URL);

    expect(test).toBeDisabled();
    expect(test).toHaveAccessibleDescription(saveFirst);
  });

  it("shows the working state while a test runs, then the success line", async () => {
    let answer: (outcome: TestOutcome) => void = () => {};
    const { calls } = renderSettings(withKey, {
      provider_test: () => new Promise<TestOutcome>((resolve) => (answer = resolve)),
    });
    await dialog();
    const test = screen.getByRole("button", { name: "Test connection" });
    expect(test).toBeEnabled();

    fireEvent.click(test);

    await waitFor(() => expect(test).toHaveAttribute("aria-busy", "true"));
    expect(test).toHaveTextContent("Working…");
    // A second press while the test runs starts nothing.
    fireEvent.click(test);
    answer({ state: "connected" });
    expect(await screen.findByRole("status")).toHaveTextContent(
      `The connection works. ${MODEL} answered.`,
    );
    expect(test).not.toHaveAttribute("aria-busy");
    expect(calls.filter(({ command }) => command === "provider_test")).toHaveLength(1);
  });

  it.each([
    ["unreachable", "openrouter.ai could not be reached: Connection refused (os error 111)."],
    [
      "insecure",
      "The secure connection to openrouter.ai failed: Connection refused (os error 111).",
    ],
    ["timeout", "openrouter.ai did not answer within 60 seconds."],
    ["key_refused", "The provider refused the API key."],
    ["key_needed", "The provider needs an API key."],
    ["not_found", "The base URL or the model was not found."],
    ["rate_limited", "The provider is limiting requests. Try again later."],
    ["refused", "The provider refused the request."],
    ["provider_error", "The provider reported a problem on its side."],
    ["redirected", "The provider redirected the request to Connection refused (os error 111)."],
    ["invalid_reply", "The answer is not an OpenAI-compatible chat reply."],
    [
      "key_unreadable",
      "The key cannot be read from its storage: Connection refused (os error 111).",
    ],
  ] satisfies [TestFailure, string][])("explains a failed test: %s", async (reason, text) => {
    renderSettings(withKey, {
      provider_test: () => ({
        state: "failed",
        reason,
        detail: "Connection refused (os error 111)",
        providerMessage: "Model <b>gone</b> & retired",
      }),
    });
    await dialog();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(text);
    expect(notice).toHaveTextContent("Model <b>gone</b> & retired");
    expect(notice.querySelector("b")).toBeNull();
    expect(notice.querySelector(".icon")).toHaveTextContent(
      reason === "rate_limited" ? glyphs.warning : glyphs.error,
    );
  });

  it("abandons a running test when it closes", async () => {
    const { calls, reopen } = renderSettings(withKey, {
      provider_test: () => new Promise<TestOutcome>(() => {}),
      provider_test_cancel: () => null,
    });
    await dialog();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(calls.at(-1)?.command).toBe("provider_test"));

    reopen();

    await waitFor(() =>
      expect(calls.map(({ command }) => command)).toContain("provider_test_cancel"),
    );
  });

  it("clears the test result when the provider is saved", async () => {
    renderSettings(withKey, {
      provider_test: () => ({ state: "connected" }),
      provider_save: () => saved(withKey),
    });
    await dialog();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("status");

    type("Model", "another/model");
    fireEvent.click(save());

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("discards unsaved edits when it closes", async () => {
    const { reopen } = renderSettings(withKey);
    await dialog();
    type("Model", "another/model");
    type("API key", "sk-unsaved");

    reopen();

    await dialog();
    expect(field("Model")).toHaveValue(MODEL);
    expect(field("API key")).toHaveValue("");
  });
});
