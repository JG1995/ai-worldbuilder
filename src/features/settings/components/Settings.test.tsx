import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ImageFailure,
  ImageProvider,
  ImageTestOutcome,
  ProviderFailure,
  ProviderSaved,
  Settings as SavedSettings,
  TestOutcome,
  TextProvider,
  Theme,
} from "@/types/api";
import { glyphs } from "@/ui/icon-glyphs";
import { applySavedTheme, resetTheme } from "../logic/saved-theme";
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

const withKey: SavedSettings = {
  ai: true,
  textProvider: provider("keychain"),
  imageProvider: null,
  theme: "saturn-seal",
};
const empty: SavedSettings = {
  ai: true,
  textProvider: null,
  imageProvider: null,
  theme: "saturn-seal",
};

const IMAGE_MODEL = "google/gemini-2.5-flash-image";
const imageProvider = (key: ImageProvider["key"]): ImageProvider => ({
  model: IMAGE_MODEL,
  key,
  host: "openrouter.ai",
});
const withImageKey: SavedSettings = { ...withKey, imageProvider: imageProvider("keychain") };
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

type Group = "Text provider" | "Image provider";

const dialog = () => screen.findByRole("dialog", { name: "Settings" });
const group = (name: Group) => within(screen.getByRole("group", { name }));
const field = (name: string, inGroup: Group = "Text provider") =>
  group(inGroup).getByLabelText(name) as HTMLInputElement;
const button = (name: string, inGroup: Group = "Text provider") =>
  group(inGroup).getByRole("button", { name });
const save = (inGroup: Group = "Text provider") => button("Save", inGroup);

function type(name: string, value: string, inGroup: Group = "Text provider") {
  fireEvent.change(field(name, inGroup), { target: { value } });
}

/** Records each element scrolled into view; jsdom has no `scrollIntoView` of its own. */
function stubScrollIntoView() {
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = function (this: Element, options) {
    expect(options).toEqual({ block: "nearest" });
    scrolled.push(this);
  };
  onTestFinished(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
  return scrolled;
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
    expect(screen.getByRole("group", { name: "Image provider" })).toBeInTheDocument();
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
    expect(screen.queryByRole("group", { name: "Image provider" })).not.toBeInTheDocument();
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
    fireEvent.click(button("Show"));
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
        keyFile ? saved({ ...empty, textProvider: provider("file") }) : { state: "no_keychain" },
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

  it("scrolls the key file warning into view and leaves focus in the key field", async () => {
    const scrolled = stubScrollIntoView();
    renderSettings(empty, { provider_save: () => ({ state: "no_keychain" }) });
    await dialog();
    type("Base URL", BASE_URL);
    type("Model", MODEL);
    type("API key", "sk-secret");
    field("API key").focus();

    fireEvent.submit(field("API key"));

    const warning = await screen.findByRole("alert");
    expect(scrolled.some((element) => element.contains(warning))).toBe(true);
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
      provider_key_remove: () => ({
        ai: true,
        textProvider: provider("none"),
        imageProvider: null,
        theme: "saturn-seal",
      }),
    });
    await dialog();

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove the API key?" });
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Cancel comes first, as in the other confirmations.
    expect(
      within(confirmation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Remove key"]);
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
    const test = button("Test connection");
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
    const test = button("Test connection");
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

  it("scrolls a test result into view and leaves focus on Test connection", async () => {
    const scrolled = stubScrollIntoView();
    renderSettings(withKey, { provider_test: () => ({ state: "connected" }) });
    await dialog();
    const test = button("Test connection");
    test.focus();

    fireEvent.click(test);

    const result = await screen.findByRole("status");
    expect(scrolled.some((element) => element.contains(result))).toBe(true);
    expect(test).toHaveFocus();
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
  ] satisfies [ProviderFailure, string][])("explains a failed test: %s", async (reason, text) => {
    renderSettings(withKey, {
      provider_test: () => ({
        state: "failed",
        reason,
        detail: "Connection refused (os error 111)",
        providerMessage: "Model <b>gone</b> & retired",
      }),
    });
    await dialog();

    fireEvent.click(button("Test connection"));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(text);
    expect(notice).toHaveTextContent("Model <b>gone</b> & retired");
    expect(notice.querySelector("b")).toBeNull();
    expect(notice.querySelector(".icon")).toHaveTextContent(
      reason === "rate_limited" ? glyphs.warning : glyphs.error,
    );
  });

  it("abandons both running tests when it closes", async () => {
    const { calls, reopen } = renderSettings(withImageKey, {
      provider_test: () => new Promise<TestOutcome>(() => {}),
      provider_test_cancel: () => null,
      image_provider_test: () => new Promise<ImageTestOutcome>(() => {}),
      image_provider_test_cancel: () => null,
    });
    await dialog();
    fireEvent.click(button("Test connection"));
    fireEvent.click(button("Test connection", "Image provider"));
    await waitFor(() => expect(calls.at(-1)?.command).toBe("image_provider_test"));

    reopen();

    await waitFor(() =>
      expect(calls.map(({ command }) => command)).toEqual(
        expect.arrayContaining(["provider_test_cancel", "image_provider_test_cancel"]),
      ),
    );
  });

  it("clears the test result when the provider is saved", async () => {
    renderSettings(withKey, {
      provider_test: () => ({ state: "connected" }),
      provider_save: () => saved(withKey),
    });
    await dialog();
    fireEvent.click(button("Test connection"));
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

  describe("image provider", () => {
    const image = "Image provider";

    it("saves the trimmed fields with a secondary Save, empties the key and names openrouter.ai", async () => {
      const { calls } = renderSettings(withKey, {
        image_provider_save: () => saved(withImageKey),
      });
      await dialog();
      expect(field("API key", image)).toHaveAccessibleDescription(
        "No key is stored. Images need an OpenRouter API key.",
      );
      // The text provider's Save stays the dialog's one primary button.
      expect(save(image).className).not.toContain("bg-accent");

      type("Model", `  ${IMAGE_MODEL} `, image);
      type("API key", " sk-or-secret\n", image);
      fireEvent.click(save(image));

      await waitFor(() =>
        expect(field("API key", image)).toHaveAccessibleDescription(keychainLine),
      );
      expect(calls.at(-1)).toEqual({
        command: "image_provider_save",
        args: { model: IMAGE_MODEL, key: "sk-or-secret", keyFile: false },
      });
      expect(field("API key", image)).toHaveValue("");
      expect(field("API key", image)).toHaveFocus();
      expect(save(image)).toBeDisabled();
    });

    it("shows a field's rule under it", async () => {
      renderSettings(withKey, {
        image_provider_save: () => ({
          state: "invalid",
          field: "model",
          message: "Enter the model's ID.",
        }),
      });
      await dialog();

      type("API key", "sk-or-secret", image);
      fireEvent.click(save(image));

      await waitFor(() => expect(field("Model", image)).toBeInvalid());
      expect(field("Model", image)).toHaveAccessibleDescription(/^Enter the model's ID\./);
      expect(field("Model")).toBeValid();
    });

    it("asks before storing the key in a file, and Store in a file stores it there", async () => {
      const { calls } = renderSettings(withKey, {
        image_provider_save: ({ keyFile }) =>
          keyFile
            ? saved({ ...withKey, imageProvider: imageProvider("file") })
            : { state: "no_keychain" },
      });
      await dialog();
      type("Model", IMAGE_MODEL, image);
      type("API key", "sk-or-secret", image);

      fireEvent.click(save(image));

      const warning = await group(image).findByRole("alert");
      expect(warning).toHaveTextContent(keyFileWarning);
      fireEvent.click(within(warning).getByRole("button", { name: "Store in a file" }));

      await waitFor(() => expect(field("API key", image)).toHaveAccessibleDescription(fileLine));
      expect(calls.at(-1)).toEqual({
        command: "image_provider_save",
        args: { model: IMAGE_MODEL, key: "sk-or-secret", keyFile: true },
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(field("API key", image)).toHaveFocus();
    });

    it("removes only the image key after a confirmation with Cancel focused", async () => {
      const { calls } = renderSettings(withImageKey, {
        image_provider_key_remove: () => ({ ...withKey, imageProvider: imageProvider("none") }),
      });
      await dialog();

      fireEvent.click(button("Remove key", image));
      const confirmation = screen.getByRole("dialog", { name: "Remove the image API key?" });
      expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
      fireEvent.click(within(confirmation).getByRole("button", { name: "Remove key" }));

      await waitFor(() =>
        expect(field("API key", image)).toHaveAccessibleDescription(
          "No key is stored. Images need an OpenRouter API key.",
        ),
      );
      expect(calls.at(-1)?.command).toBe("image_provider_key_remove");
      expect(group(image).queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
      expect(button("Test connection", image)).toBeDisabled();
      expect(field("API key", image)).toHaveFocus();
      expect(field("API key")).toHaveAccessibleDescription(keychainLine);
    });

    it("offers Test connection only without unsaved edits, and shows its success", async () => {
      renderSettings(withImageKey, {
        image_provider_test: () => ({ state: "success" }),
      });
      await dialog();
      const test = button("Test connection", image);

      type("Model", "another/model", image);
      expect(test).toBeDisabled();
      expect(test).toHaveAccessibleDescription(saveFirst);
      // The text provider has no unsaved edits, so its test stays available.
      expect(button("Test connection")).toBeEnabled();

      type("Model", IMAGE_MODEL, image);
      fireEvent.click(test);

      expect(await group(image).findByRole("status")).toHaveTextContent(
        `The connection works. OpenRouter accepted the key and lists ${IMAGE_MODEL} as an image model.`,
      );
    });

    it.each([
      ["key_refused", "OpenRouter did not accept the API key."],
      ["no_credit", "The OpenRouter account is out of credit, or the key reached its limit."],
      ["unknown_model", `${IMAGE_MODEL} is not one of OpenRouter's image models.`],
      ["rate_limited", "OpenRouter is limiting requests. Wait a moment before trying again."],
    ] satisfies [ImageFailure, string][])("explains a failed test: %s", async (reason, text) => {
      renderSettings(withImageKey, {
        image_provider_test: () => ({
          state: "failed",
          reason,
          detail: null,
          providerMessage: "Model <b>gone</b> & retired",
        }),
      });
      await dialog();

      fireEvent.click(button("Test connection", image));

      const notice = await group(image).findByRole("alert");
      expect(notice).toHaveTextContent(text);
      expect(notice).toHaveTextContent("The provider's message: Model <b>gone</b> & retired");
      expect(notice.querySelector("b")).toBeNull();
      expect(notice.querySelector(".icon")).toHaveTextContent(
        reason === "rate_limited" ? glyphs.warning : glyphs.error,
      );
    });

    it("keeps its draft and test result when the text provider is saved", async () => {
      renderSettings(withImageKey, {
        image_provider_test: () => ({ state: "success" }),
        provider_save: () => saved({ ...withImageKey, textProvider: provider("file") }),
      });
      await dialog();
      fireEvent.click(button("Test connection", image));
      const result = await group(image).findByRole("status");
      type("API key", "sk-or-unsaved", image);

      type("Model", "another/model");
      fireEvent.click(save());

      await waitFor(() => expect(field("API key")).toHaveAccessibleDescription(fileLine));
      expect(result).toBeInTheDocument();
      expect(field("API key", image)).toHaveValue("sk-or-unsaved");
    });
  });

  describe("appearance", () => {
    afterEach(resetTheme);

    /** Starts the application in `theme`, as `main.tsx` does before anything renders. */
    async function startIn(theme: Theme) {
      vi.stubGlobal("isTauri", true);
      mockIPC(() => ({ ...empty, theme }));
      await applySavedTheme();
    }

    const radio = (name: string) => screen.getByRole("radio", { name });

    it.each([
      ["on", true],
      ["off", false],
    ])("shows first with the saved theme checked and focused, with AI %s", async (_, ai) => {
      await startIn("bound");
      renderSettings({ ...withKey, ai, theme: "bound" });
      const settings = await dialog();

      const appearance = within(settings).getAllByRole("group")[0];
      expect(appearance).toHaveAccessibleName("Appearance");
      const options = within(appearance).getByRole("radiogroup", { name: "Theme" });
      expect(within(options).getAllByRole("radio")).toEqual([
        radio("Saturn Seal"),
        radio("Bound"),
        radio("Lamplight"),
      ]);
      expect(radio("Lamplight")).toHaveAccessibleDescription(
        "Night green with candle-yellow light and one serif.",
      );
      expect(radio("Bound")).toBeChecked();
      expect(radio("Bound")).toHaveFocus();
    });

    it("applies a choice at once and saves it", async () => {
      const { calls } = renderSettings(empty, {
        settings_theme_set: ({ theme }) => ({ ...empty, theme }),
      });
      await dialog();

      fireEvent.click(radio("Lamplight"));

      expect(document.documentElement.dataset.theme).toBe("lamplight");
      expect(radio("Lamplight")).toBeChecked();
      await waitFor(() =>
        expect(calls.at(-1)).toEqual({
          command: "settings_theme_set",
          args: { theme: "lamplight" },
        }),
      );
    });

    it("returns to the saved theme with the reason when a save fails, until a choice saves", async () => {
      await startIn("bound");
      let fail = true;
      renderSettings(
        { ...empty, theme: "bound" },
        {
          settings_theme_set: ({ theme }) => {
            if (fail) throw { kind: "io", message: "Read-only file system." };
            return { ...empty, theme };
          },
        },
      );
      await dialog();

      fireEvent.click(radio("Lamplight"));

      const appearance = within(screen.getByRole("group", { name: "Appearance" }));
      expect(await appearance.findByRole("alert")).toHaveTextContent(
        "The setting could not be saved: Read-only file system.",
      );
      expect(document.documentElement.dataset.theme).toBe("bound");
      expect(radio("Bound")).toBeChecked();

      fail = false;
      fireEvent.click(radio("Lamplight"));

      await waitFor(() => expect(appearance.queryByRole("alert")).not.toBeInTheDocument());
      expect(document.documentElement.dataset.theme).toBe("lamplight");
    });

    it("saves the last of quick choices, one save at a time", async () => {
      const finish: (() => void)[] = [];
      let inFlight = 0;
      let mostInFlight = 0;
      const { calls } = renderSettings(empty, {
        settings_theme_set: ({ theme }) => {
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);
          return new Promise((resolve) =>
            finish.push(() => {
              inFlight -= 1;
              resolve({ ...empty, theme });
            }),
          );
        },
      });
      await dialog();

      fireEvent.click(radio("Bound"));
      fireEvent.click(radio("Saturn Seal"));
      fireEvent.click(radio("Lamplight"));
      await waitFor(() => expect(finish).toHaveLength(1));
      finish[0]();
      await waitFor(() => expect(finish).toHaveLength(2));
      finish[1]();

      await waitFor(() => expect(inFlight).toBe(0));
      const sent = calls.filter(({ command }) => command === "settings_theme_set");
      expect(sent.map(({ args }) => args)).toEqual([{ theme: "bound" }, { theme: "lamplight" }]);
      expect(mostInFlight).toBe(1);
      expect(document.documentElement.dataset.theme).toBe("lamplight");
      expect(radio("Lamplight")).toBeChecked();
    });

    it("keeps a provider saved while the theme was saving", async () => {
      let finishTheme = () => {};
      renderSettings(empty, {
        // The core's answer holds no provider: it was made before the provider was saved.
        settings_theme_set: ({ theme }) =>
          new Promise((resolve) => {
            finishTheme = () => resolve({ ...empty, theme });
          }),
        provider_save: () => saved(withKey),
      });
      await dialog();
      fireEvent.click(radio("Lamplight"));
      type("Base URL", BASE_URL);
      type("Model", MODEL);
      type("API key", "sk-secret");
      fireEvent.click(save());
      await waitFor(() => expect(field("API key")).toHaveAccessibleDescription(keychainLine));

      // The cache tells its observers on a timer.
      await act(async () => {
        finishTheme();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(field("API key")).toHaveAccessibleDescription(keychainLine);
      expect(radio("Lamplight")).toBeChecked();
    });
  });
});
