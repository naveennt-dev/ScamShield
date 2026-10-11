"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export const QueryClientProviderWrapper = ({ children }: { children: React.ReactNode }) => {
  // One client per browser session (a module-level client would be shared across SSR requests).
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
