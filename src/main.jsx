import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/Tooltip";

import "@/styles/globals.css";
import { AppRoutes } from "@/routes/AppRoutes";
import { useAuthStore } from "@/stores/auth";
import { useOrgStore } from "@/stores/org";

// Dev-only demo bootstrap. When `?__demo=1` is in the URL, synchronously seed
// the auth + org stores from `window.__DEMO_STATE__` so the screenshot harness
// can capture authenticated pages without a real backend session. Stripped at
// build time — `import.meta.env.DEV` is false in production.
if (import.meta.env.DEV && typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  if (params.get("__demo") === "1" && window.__DEMO_STATE__) {
    const { user, accessToken, refreshToken, orgId } = window.__DEMO_STATE__;
    useAuthStore.setState({ user, accessToken, refreshToken });
    useOrgStore.setState({ activeOrgId: orgId });
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
        <Toaster
          position="bottom-right"
          theme="light"
          toastOptions={{
            classNames: {
              toast: "!bg-ink-950 !text-ink-0 !border-0 !rounded !shadow-popover",
              title: "!font-medium !tracking-tight",
              description: "!text-ink-300",
              actionButton: "!bg-accent !text-accent-fg",
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
