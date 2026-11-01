import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { QuickOpen } from "@/features/search/components/QuickOpen";
import { World } from "@/features/world/components/World";

// Commands answer from the local core: a failure is reported at once rather than retried, and
// results change only when the application asks again, not when the window regains focus.
const queryDefaults = {
  queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
};

export function App() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: queryDefaults }));

  return (
    <QueryClientProvider client={queryClient}>
      <World quickOpen={(ports) => <QuickOpen {...ports} />} />
    </QueryClientProvider>
  );
}
