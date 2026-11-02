import type { WorldScreenParts } from "@/features/world/components/WorldScreen";
import { Shell } from "@/ui/Shell";

/** The open world's screen: its parts in the shell. */
export function WorldLayout(parts: WorldScreenParts) {
  return <Shell {...parts} />;
}
