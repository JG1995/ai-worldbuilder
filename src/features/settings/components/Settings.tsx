import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import type {
  ImageProvider,
  ImageTestOutcome,
  KeyStorage,
  ProviderField,
  Settings as SavedSettings,
  TestOutcome,
  TextProvider,
} from "@/types/api";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Notice } from "@/ui/Notice";
import { TextInput } from "@/ui/TextInput";
import { Toggle } from "@/ui/Toggle";
import {
  imageProviderKeyRemove,
  imageProviderSave,
  imageProviderTest,
  imageProviderTestCancel,
  providerKeyRemove,
  providerSave,
  providerTest,
  providerTestCancel,
  settingsAiSet,
  settingsGet,
  settingsGetKey,
} from "../api/commands";

const aiDescription =
  "Off hides the assistant and every AI feature, and sends nothing to an AI provider. Your provider settings are kept.";

const keyFileWarning =
  "No system keychain is available, so the key cannot be stored there. Grimoire.md can store it in a file in its data folder that only your user account can read. Anyone who can use your account or read your backups can read the key.";

type SettingsProps = {
  /** Closes Settings; unsaved edits are discarded. */
  onClose: () => void;
};

/** The Settings dialog. It shows nothing until the saved settings have arrived. */
export function Settings({ onClose }: SettingsProps) {
  const settings = useQuery({ queryKey: settingsGetKey, queryFn: settingsGet });
  if (!settings.data) return null;
  return <SettingsDialog saved={settings.data} onClose={onClose} />;
}

/** The provider fields as the user typed them. The key is never kept beyond this state. */
type Draft = { baseUrl: string; model: string; key: string };

const draftOf = (provider: TextProvider | null): Draft => ({
  baseUrl: provider?.baseUrl ?? "",
  model: provider?.model ?? "",
  key: "",
});

/** Where a saved provider's key is stored and where it is sent; `none` without a stored key. */
function keyStatus(provider: { key: KeyStorage; host: string } | null, none: string) {
  switch (provider?.key) {
    case "keychain":
      return `Stored in the system keychain. Sent only to ${provider.host}.`;
    case "file":
      return `Stored in a file only your account can read. Sent only to ${provider.host}.`;
    default:
      return none;
  }
}

/** `text`, then `reason` when there is one, as one sentence. */
function withReason(text: string, reason: string | null) {
  if (!reason) return `${text}.`;
  return /[.!?]$/.test(reason) ? `${text}: ${reason}` : `${text}: ${reason}.`;
}

type FailedTest = Extract<TestOutcome, { state: "failed" }>;

/** What a failed test means for the provider saved at `host`, and what to check. */
function failureText({ reason, detail }: FailedTest, host: string) {
  switch (reason) {
    case "unreachable":
      return `${withReason(`${host} could not be reached`, detail)} Check the base URL and your network connection.`;
    case "insecure":
      return `${withReason(`The secure connection to ${host} failed`, detail)} Check the base URL, and that the server's certificate is valid.`;
    case "timeout":
      return `${host} did not answer within 60 seconds. Try again later, or check the base URL.`;
    case "key_refused":
      return "The provider refused the API key. Check that the key is valid for this provider.";
    case "key_needed":
      return "The provider needs an API key. Type one and save it.";
    case "not_found":
      return "The base URL or the model was not found. Check the base URL, and copy the model's ID from the provider's list of models.";
    case "rate_limited":
      return "The provider is limiting requests. Try again later.";
    case "refused":
      return "The provider refused the request.";
    case "provider_error":
      return "The provider reported a problem on its side. Try again later.";
    case "redirected":
      return `The provider redirected the request to ${detail ?? "another address"}. Check the base URL.`;
    case "invalid_reply":
      return "The answer is not an OpenAI-compatible chat reply. Check the base URL.";
    case "key_unreadable":
      return withReason("The key cannot be read from its storage", detail);
  }
}

/** The origin of `text` as a URL, or null when it is not one. */
function originOf(text: string) {
  try {
    return new URL(text.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Scrolls a notice that appears into the dialog's body, which may end above it in a small window;
 * focus stays where it is.
 */
function scrollIntoBody(notice: HTMLElement | null) {
  // jsdom has no scrollIntoView.
  if (!notice?.scrollIntoView) return;
  notice.scrollIntoView({ block: "nearest" });
}

function SettingsDialog({ saved, onClose }: { saved: SavedSettings; onClose: () => void }) {
  const queryClient = useQueryClient();
  const provider = saved.textProvider;
  const [draft, setDraft] = useState(() => draftOf(provider));
  const [showKey, setShowKey] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: ProviderField; message: string } | null>(
    null,
  );
  const [askKeyFile, setAskKeyFile] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [aiFailure, setAiFailure] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const aiSwitch = useRef<HTMLButtonElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  // Bumped to move focus to the key field once the control that had it is gone.
  const [keyFocusRequest, setKeyFocusRequest] = useState(0);
  const groupId = useId();
  const testHintId = useId();
  // A test runs on its own, so a save, a removal or the switch can abandon it.
  const testRunning = useRef(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);

  useEffect(() => {
    if (keyFocusRequest > 0) keyInput.current?.focus();
  }, [keyFocusRequest]);

  // Closing Settings abandons a running test.
  useEffect(
    () => () => {
      if (testRunning.current) providerTestCancel().catch(() => {});
    },
    [],
  );

  const focusKeyField = () => setKeyFocusRequest((request) => request + 1);
  const keyTyped = draft.key.trim() !== "";
  const edited =
    keyTyped ||
    draft.baseUrl !== (provider?.baseUrl ?? "") ||
    draft.model !== (provider?.model ?? "");
  const keyStored = provider !== null && provider.key !== "none";
  const savedOrigin = provider && originOf(provider.baseUrl);
  const draftOrigin = originOf(draft.baseUrl);
  const originChanges =
    keyStored && !keyTyped && draftOrigin !== null && draftOrigin !== savedOrigin;

  /** Takes the core's settings as the saved ones and the fields back to them. */
  function adopt(settings: SavedSettings) {
    queryClient.setQueryData(settingsGetKey, settings);
    setDraft(draftOf(settings.textProvider));
    setShowKey(false);
    setFieldError(null);
    setAskKeyFile(false);
    setFailure(null);
    setTestOutcome(null);
  }

  async function testConnection() {
    if (testRunning.current) return;
    testRunning.current = true;
    setTesting(true);
    setTestOutcome(null);
    setFailure(null);
    try {
      setTestOutcome(await providerTest());
    } catch (error) {
      setFailure(`The connection could not be tested: ${(error as IpcError).message}`);
    } finally {
      testRunning.current = false;
      setTesting(false);
    }
  }

  function edit(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (fieldError?.field === (field === "baseUrl" ? "base_url" : field)) setFieldError(null);
  }

  async function setAi(on: boolean) {
    if (busy.current) return;
    busy.current = true;
    try {
      adopt(await settingsAiSet(on));
      setAiFailure(null);
    } catch (error) {
      setAiFailure(`The setting could not be saved: ${(error as IpcError).message}`);
    } finally {
      busy.current = false;
    }
  }

  async function save(keyFile: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const result = await providerSave(
        draft.baseUrl,
        draft.model.trim(),
        keyTyped ? draft.key : null,
        keyFile,
      );
      if (result.state === "saved") {
        // Save is unavailable now, so focus would leave the dialog.
        adopt(result.settings);
        focusKeyField();
      } else if (result.state === "invalid") {
        setAskKeyFile(false);
        setFieldError({ field: result.field, message: result.message });
      } else {
        setAskKeyFile(true);
      }
    } catch (error) {
      const { kind, message } = error as IpcError;
      // A keychain error comes from storing the typed key, or without one, from removing the
      // stored key for a new origin.
      const context = keyTyped
        ? "The key could not be stored in the system keychain"
        : "The stored key could not be removed from the system keychain";
      setAskKeyFile(false);
      setFailure(kind === "keychain" ? `${context}: ${message}` : message);
    } finally {
      busy.current = false;
      setSaving(false);
      // Store in a file disappears with the warning, whatever the answer.
      if (keyFile) focusKeyField();
    }
  }

  function cancelKeyFile() {
    setAskKeyFile(false);
    focusKeyField();
  }

  async function removeKey() {
    setConfirmingRemoval(false);
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    try {
      adopt(await providerKeyRemove());
      focusKeyField();
    } catch (error) {
      setFailure(`The key could not be removed: ${(error as IpcError).message}`);
    } finally {
      busy.current = false;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (edited) void save(false);
  }

  const errorOf = (field: ProviderField) =>
    fieldError?.field === field ? fieldError.message : undefined;

  return (
    <>
      <Dialog title="Settings" wide closeButton onCancel={onClose} initialFocus={aiSwitch}>
        <Toggle
          ref={aiSwitch}
          label="AI features"
          checked={saved.ai}
          onChange={(on) => void setAi(on)}
          description={aiDescription}
        />
        {aiFailure && <Notice status="error">{aiFailure}</Notice>}
        {saved.ai && (
          <form onSubmit={submit}>
            <fieldset
              aria-labelledby={groupId}
              className="flex min-w-0 flex-col gap-4 border-divider border-t pt-4"
            >
              <h3 id={groupId} className="label-caps text-text-muted">
                Text provider
              </h3>
              <TextInput
                label="Base URL"
                value={draft.baseUrl}
                onChange={(event) => edit("baseUrl", event.target.value)}
                placeholder="https://openrouter.ai/api/v1"
                autoComplete="off"
                spellCheck={false}
                error={errorOf("base_url")}
              />
              <TextInput
                label="Model"
                value={draft.model}
                onChange={(event) => edit("model", event.target.value)}
                placeholder="anthropic/claude-sonnet-4.5"
                autoComplete="off"
                spellCheck={false}
                error={errorOf("model")}
                description="Copy the model's ID from the provider's list of models."
              />
              <TextInput
                ref={keyInput}
                label="API key"
                type={showKey ? "text" : "password"}
                value={draft.key}
                onChange={(event) => edit("key", event.target.value)}
                placeholder={keyStored ? "Type a new key to replace the stored one" : "Optional"}
                autoComplete="off"
                spellCheck={false}
                error={errorOf("key")}
                action={
                  <Button variant="ghost" onClick={() => setShowKey((shown) => !shown)}>
                    {showKey ? "Hide" : "Show"}
                  </Button>
                }
                description={
                  <>
                    <p>{keyStatus(provider, "No key is stored. Requests are sent without one.")}</p>
                    {originChanges && (
                      <p>
                        The stored key is for {provider.host} and will be removed when you save.
                      </p>
                    )}
                  </>
                }
              />
              {askKeyFile && (
                <KeyFileWarning onStore={() => void save(true)} onCancel={cancelKeyFile} />
              )}
              {failure && <Notice status="error">{failure}</Notice>}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" type="submit" disabled={!edited} loading={saving}>
                  Save
                </Button>
                <Button
                  variant="secondary"
                  disabled={!provider || edited}
                  loading={testing}
                  onClick={() => void testConnection()}
                  aria-describedby={edited ? testHintId : undefined}
                >
                  Test connection
                </Button>
                {keyStored && (
                  <Button variant="ghost" onClick={() => setConfirmingRemoval(true)}>
                    Remove key
                  </Button>
                )}
              </div>
              {edited && (
                <p id={testHintId} className="ui-small text-text-muted">
                  Save your changes to test the connection.
                </p>
              )}
              {testOutcome && provider && <TestResult outcome={testOutcome} provider={provider} />}
            </fieldset>
          </form>
        )}
        {saved.ai && <ImageProviderGroup provider={saved.imageProvider} />}
      </Dialog>
      {confirmingRemoval && (
        <RemoveKeyConfirmation
          title="Remove the API key?"
          onConfirm={() => void removeKey()}
          onCancel={() => setConfirmingRemoval(false)}
        />
      )}
    </>
  );
}

/** The test's result; a cancelled test shows none. The provider's message is plain text. */
function TestResult({ outcome, provider }: { outcome: TestOutcome; provider: TextProvider }) {
  if (outcome.state === "cancelled") return null;
  return (
    <div ref={scrollIntoBody}>
      {outcome.state === "connected" ? (
        <Notice status="success">The connection works. {provider.model} answered.</Notice>
      ) : (
        <Notice status={outcome.reason === "rate_limited" ? "warning" : "error"}>
          <span className="block">{failureText(outcome, provider.host)}</span>
          {outcome.providerMessage && (
            <span className="block break-words">
              The provider's message: {outcome.providerMessage}
            </span>
          )}
        </Notice>
      )}
    </div>
  );
}

/** Asks before a key is stored in the key file; it scrolls into the dialog's body. */
function KeyFileWarning({ onStore, onCancel }: { onStore: () => void; onCancel: () => void }) {
  return (
    <div ref={scrollIntoBody}>
      <Notice
        status="warning"
        actions={
          <>
            <Button variant="secondary" onClick={onStore}>
              Store in a file
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </>
        }
      >
        {keyFileWarning}
      </Notice>
    </div>
  );
}

/** The image provider's fields as the user typed them. The key is never kept beyond this state. */
type ImageDraft = { model: string; key: string };

const imageDraftOf = (provider: ImageProvider | null): ImageDraft => ({
  model: provider?.model ?? "",
  key: "",
});

type FailedImageTest = Extract<ImageTestOutcome, { state: "failed" }>;

/** What a failed image provider test means for `provider`, and what to check. */
function imageFailureText({ reason, detail }: FailedImageTest, { model, host }: ImageProvider) {
  switch (reason) {
    case "unreachable":
      return `${withReason(`${host} could not be reached`, detail)} Check your network connection.`;
    case "insecure":
      return `${withReason(`The secure connection to ${host} failed`, detail)} Check your network connection.`;
    case "timeout":
      return `${host} did not answer within 60 seconds. Try again later.`;
    case "key_refused":
      return "OpenRouter did not accept the API key. Check that the key is a valid OpenRouter key.";
    case "no_credit":
      return "The OpenRouter account is out of credit, or the key reached its limit.";
    case "unknown_model":
      return `${model} is not one of OpenRouter's image models. Copy the model's ID from OpenRouter's list of image models.`;
    case "rate_limited":
      return "OpenRouter is limiting requests. Wait a moment before trying again.";
    case "refused":
      return "OpenRouter refused the request.";
    case "provider_error":
      return "OpenRouter reported a problem on its side. Try again later.";
    case "redirected":
      return `OpenRouter redirected the request to ${detail ?? "another address"}.`;
    case "invalid_reply":
      return "OpenRouter's answer could not be read.";
    case "no_image":
      return "OpenRouter returned no usable image.";
    case "key_unreadable":
      return withReason("The key cannot be read from its storage", detail);
    case "interrupted":
      return "The connection was interrupted. Try again.";
  }
}

/**
 * The image provider's group: its own draft, key-file warning, field errors and test result, apart
 * from the text provider's. It exists only while AI is on, so switching AI off clears its state;
 * leaving, whether by closing Settings or by AI off, abandons a running test.
 */
function ImageProviderGroup({ provider }: { provider: ImageProvider | null }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => imageDraftOf(provider));
  const [showKey, setShowKey] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: ProviderField; message: string } | null>(
    null,
  );
  const [askKeyFile, setAskKeyFile] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  // Bumped to move focus to the key field once the control that had it is gone.
  const [keyFocusRequest, setKeyFocusRequest] = useState(0);
  const groupId = useId();
  const testHintId = useId();
  const testRunning = useRef(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<ImageTestOutcome | null>(null);

  useEffect(() => {
    if (keyFocusRequest > 0) keyInput.current?.focus();
  }, [keyFocusRequest]);

  useEffect(
    () => () => {
      if (testRunning.current) imageProviderTestCancel().catch(() => {});
    },
    [],
  );

  const focusKeyField = () => setKeyFocusRequest((request) => request + 1);
  const keyTyped = draft.key.trim() !== "";
  const edited = keyTyped || draft.model !== (provider?.model ?? "");
  const keyStored = provider !== null && provider.key !== "none";

  /** Takes the core's settings as the saved ones and the fields back to them. */
  function adopt(settings: SavedSettings) {
    queryClient.setQueryData(settingsGetKey, settings);
    setDraft(imageDraftOf(settings.imageProvider));
    setShowKey(false);
    setFieldError(null);
    setAskKeyFile(false);
    setFailure(null);
    setTestOutcome(null);
  }

  function edit(field: keyof ImageDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (fieldError?.field === field) setFieldError(null);
  }

  async function testConnection() {
    if (testRunning.current) return;
    testRunning.current = true;
    setTesting(true);
    setTestOutcome(null);
    setFailure(null);
    try {
      setTestOutcome(await imageProviderTest());
    } catch (error) {
      setFailure(`The connection could not be tested: ${(error as IpcError).message}`);
    } finally {
      testRunning.current = false;
      setTesting(false);
    }
  }

  async function save(keyFile: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const result = await imageProviderSave(
        draft.model.trim(),
        keyTyped ? draft.key.trim() : null,
        keyFile,
      );
      if (result.state === "saved") {
        // Save is unavailable now, so focus would leave the dialog.
        adopt(result.settings);
        focusKeyField();
      } else if (result.state === "invalid") {
        setAskKeyFile(false);
        setFieldError({ field: result.field, message: result.message });
      } else {
        setAskKeyFile(true);
      }
    } catch (error) {
      const { kind, message } = error as IpcError;
      setAskKeyFile(false);
      setFailure(
        kind === "keychain"
          ? `The key could not be stored in the system keychain: ${message}`
          : message,
      );
    } finally {
      busy.current = false;
      setSaving(false);
      // Store in a file disappears with the warning, whatever the answer.
      if (keyFile) focusKeyField();
    }
  }

  function cancelKeyFile() {
    setAskKeyFile(false);
    focusKeyField();
  }

  async function removeKey() {
    setConfirmingRemoval(false);
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    try {
      adopt(await imageProviderKeyRemove());
      focusKeyField();
    } catch (error) {
      setFailure(`The key could not be removed: ${(error as IpcError).message}`);
    } finally {
      busy.current = false;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (edited) void save(false);
  }

  const errorOf = (field: ProviderField) =>
    fieldError?.field === field ? fieldError.message : undefined;

  return (
    <form onSubmit={submit}>
      <fieldset
        aria-labelledby={groupId}
        className="flex min-w-0 flex-col gap-4 border-divider border-t pt-4"
      >
        <h3 id={groupId} className="label-caps text-text-muted">
          Image provider
        </h3>
        <TextInput
          label="Model"
          value={draft.model}
          onChange={(event) => edit("model", event.target.value)}
          placeholder="google/gemini-2.5-flash-image"
          autoComplete="off"
          spellCheck={false}
          error={errorOf("model")}
          description="Copy the ID of an image model from OpenRouter's list of image models."
        />
        <TextInput
          ref={keyInput}
          label="API key"
          type={showKey ? "text" : "password"}
          value={draft.key}
          onChange={(event) => edit("key", event.target.value)}
          placeholder={keyStored ? "Type a new key to replace the stored one" : undefined}
          autoComplete="off"
          spellCheck={false}
          error={errorOf("key")}
          action={
            <Button variant="ghost" onClick={() => setShowKey((shown) => !shown)}>
              {showKey ? "Hide" : "Show"}
            </Button>
          }
          description={keyStatus(provider, "No key is stored. Images need an OpenRouter API key.")}
        />
        {askKeyFile && <KeyFileWarning onStore={() => void save(true)} onCancel={cancelKeyFile} />}
        {failure && <Notice status="error">{failure}</Notice>}
        <div className="flex flex-wrap gap-2">
          {/* Secondary, so the dialog keeps the text provider's Save as its one primary. */}
          <Button variant="secondary" type="submit" disabled={!edited} loading={saving}>
            Save
          </Button>
          <Button
            variant="secondary"
            disabled={!keyStored || edited}
            loading={testing}
            onClick={() => void testConnection()}
            aria-describedby={edited ? testHintId : undefined}
          >
            Test connection
          </Button>
          {keyStored && (
            <Button variant="ghost" onClick={() => setConfirmingRemoval(true)}>
              Remove key
            </Button>
          )}
        </div>
        {edited && (
          <p id={testHintId} className="ui-small text-text-muted">
            Save your changes to test the connection.
          </p>
        )}
        {testOutcome && provider && <ImageTestResult outcome={testOutcome} provider={provider} />}
      </fieldset>
      {confirmingRemoval && (
        <RemoveKeyConfirmation
          title="Remove the image API key?"
          onConfirm={() => void removeKey()}
          onCancel={() => setConfirmingRemoval(false)}
        />
      )}
    </form>
  );
}

/** The image test's result; a cancelled test shows none. The provider's message is plain text. */
function ImageTestResult({
  outcome,
  provider,
}: {
  outcome: ImageTestOutcome;
  provider: ImageProvider;
}) {
  if (outcome.state === "cancelled") return null;
  return (
    <div ref={scrollIntoBody}>
      {outcome.state === "success" ? (
        <Notice status="success">
          The connection works. OpenRouter accepted the key and lists {provider.model} as an image
          model.
        </Notice>
      ) : (
        <Notice status={outcome.reason === "rate_limited" ? "warning" : "error"}>
          <span className="block">{imageFailureText(outcome, provider)}</span>
          {outcome.providerMessage && (
            <span className="block break-words">
              The provider's message: {outcome.providerMessage}
            </span>
          )}
        </Notice>
      )}
    </div>
  );
}

function RemoveKeyConfirmation({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title={title}
      initialFocus={cancel}
      onCancel={onCancel}
      actions={
        <>
          <Button variant="destructive" onClick={onConfirm}>
            Remove key
          </Button>
          <Button ref={cancel} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </>
      }
    >
      Grimoire.md cannot show the key again. To use it again, you will need it from your provider.
    </Dialog>
  );
}
