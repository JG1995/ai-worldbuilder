import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { IpcError } from "@/lib/ipc";
import type { ProviderField, Settings as SavedSettings, TextProvider } from "@/types/api";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Notice } from "@/ui/Notice";
import { TextInput } from "@/ui/TextInput";
import { Toggle } from "@/ui/Toggle";
import {
  providerKeyRemove,
  providerSave,
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

function keyStatus(provider: TextProvider | null) {
  switch (provider?.key) {
    case "keychain":
      return `Stored in the system keychain. Sent only to ${provider.host}.`;
    case "file":
      return `Stored in a file only your account can read. Sent only to ${provider.host}.`;
    default:
      return "No key is stored. Requests are sent without one.";
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

  useEffect(() => {
    if (keyFocusRequest > 0) keyInput.current?.focus();
  }, [keyFocusRequest]);

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
        draft.model,
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
          <form
            aria-labelledby={groupId}
            onSubmit={submit}
            className="flex flex-col gap-4 border-divider border-t pt-4"
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
                  <p>{keyStatus(provider)}</p>
                  {originChanges && (
                    <p>The stored key is for {provider.host} and will be removed when you save.</p>
                  )}
                </>
              }
            />
            {askKeyFile && (
              <Notice
                status="warning"
                actions={
                  <>
                    <Button variant="secondary" onClick={() => void save(true)}>
                      Store in a file
                    </Button>
                    <Button variant="ghost" onClick={cancelKeyFile}>
                      Cancel
                    </Button>
                  </>
                }
              >
                {keyFileWarning}
              </Notice>
            )}
            {failure && <Notice status="error">{failure}</Notice>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" type="submit" disabled={!edited} loading={saving}>
                Save
              </Button>
              {keyStored && (
                <Button variant="ghost" onClick={() => setConfirmingRemoval(true)}>
                  Remove key
                </Button>
              )}
            </div>
          </form>
        )}
      </Dialog>
      {confirmingRemoval && (
        <RemoveKeyConfirmation
          onConfirm={() => void removeKey()}
          onCancel={() => setConfirmingRemoval(false)}
        />
      )}
    </>
  );
}

function RemoveKeyConfirmation({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title="Remove the API key?"
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
