import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { assistantStop } from "@/features/assistant/api/commands";
import { QuickOpen } from "@/features/search/components/QuickOpen";
import { settingsGet, settingsGetKey } from "@/features/settings/api/commands";
import { Settings } from "@/features/settings/components/Settings";
import { World } from "@/features/world/components/World";
import { useWorldStore } from "@/features/world/stores/world-store";
import { WorldLayout } from "./WorldLayout";

// Commands answer from the local core: a failure is reported at once rather than retried, and
// results change only when the application asks again, not when the window regains focus.
const queryDefaults = {
  queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
};

export function App() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: queryDefaults }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => setSettingsOpen(true);
  // The world's layout reads the same query once a world is open; the launch does not wait for it.
  const worldOpen = useWorldStore((store) => store.world !== null);
  const settings = useQuery(
    { queryKey: settingsGetKey, queryFn: settingsGet, enabled: worldOpen },
    queryClient,
  );

  return (
    <QueryClientProvider client={queryClient}>
      <World
        quickOpen={(ports) => <QuickOpen {...ports} />}
        onOpenSettings={openSettings}
        layout={(parts) => <WorldLayout {...parts} onOpenSettings={openSettings} />}
        // A running answer stops and is saved, and every image generation stops, before the world
        // changes or the window closes. With AI off the core refuses, and there is nothing to stop.
        beforeWorldChange={() => assistantStop({ generations: true }).catch(() => {})}
        ai={settings.data?.ai === true}
      />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </QueryClientProvider>
  );
}
