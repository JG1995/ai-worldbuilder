import { Button } from "./Button";
import { Notice } from "./Notice";

type AssistantPaneProps = {
  /** The saved text provider's model. Without it, no provider is saved. */
  model?: string;
  /** The saved text provider's host, where the assistant sends what it reads. */
  host?: string;
  onOpenSettings: () => void;
};

/**
 * The assistant pane's content: its header, with the model's name when a provider is saved, then
 * either the notice that asks for a provider or the explanation of an empty conversation.
 */
export function AssistantPane({ model, host, onOpenSettings }: AssistantPaneProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-tab-strip shrink-0 items-center gap-2 border-divider border-b bg-window px-3">
        <h2 className="label-caps shrink-0 text-text">Assistant</h2>
        {model && <span className="ui-small min-w-0 truncate text-text-muted">{model}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-page">
        {model ? (
          <p className="ui p-4 text-text-muted">
            For each message, the assistant reads the pages of this world that matter to it and
            sends them, with your message, to {host}. It answers here and changes no pages.
          </p>
        ) : (
          <Notice
            status="info"
            actions={
              <Button variant="secondary" onClick={onOpenSettings}>
                Settings
              </Button>
            }
          >
            Add a provider in Settings to use the assistant.
          </Notice>
        )}
      </div>
    </div>
  );
}
