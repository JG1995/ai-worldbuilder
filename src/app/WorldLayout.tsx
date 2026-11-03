import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";
import { Assistant } from "@/features/assistant/components/Assistant";
import { settingsGet, settingsGetKey } from "@/features/settings/api/commands";
import type { WorldScreenParts } from "@/features/world/components/WorldScreen";
import { assistantSideQuery, Shell } from "@/ui/Shell";

type WorldLayoutProps = WorldScreenParts & {
  onOpenSettings: () => void;
};

/**
 * The open world's screen: its parts in the shell, with the assistant once the settings have loaded
 * with AI on; a new world session starts it anew, with the conversation it showed last. While AI is
 * on, Ctrl/Cmd+Shift+A opens and closes the pane, as its button does.
 */
export function WorldLayout({
  onOpenSettings,
  changingWorld,
  assistantPorts,
  assistantConversation,
  onAssistantConversationChange,
  ...parts
}: WorldLayoutProps) {
  const settings = useQuery({ queryKey: settingsGetKey, queryFn: settingsGet });
  const ai = settings.data?.ai === true;
  const provider = settings.data?.textProvider;

  const toggleAssistant = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    if (changingWorld || document.activeElement?.closest('[aria-modal="true"]')) return;
    // A collapsed assistant, as in the reading layout, opens by its overlay state at every width.
    if (!parts.assistantCollapsed && window.matchMedia(assistantSideQuery).matches) {
      parts.onAssistantOpenChange(!parts.assistantOpen);
    } else {
      parts.onAssistantOverlayOpenChange(!parts.assistantOverlayOpen);
    }
  });

  useEffect(() => {
    if (!ai) return;
    window.addEventListener("keydown", toggleAssistant);
    return () => window.removeEventListener("keydown", toggleAssistant);
  }, [ai]);

  return (
    <Shell
      {...parts}
      assistant={
        ai ? (
          <Assistant
            key={assistantPorts.session}
            ports={assistantPorts}
            conversation={assistantConversation}
            onConversationChange={onAssistantConversationChange}
            model={provider?.model}
            host={provider?.host}
            onOpenSettings={onOpenSettings}
          />
        ) : undefined
      }
    />
  );
}
