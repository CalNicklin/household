import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useLive } from "../data/live.ts";
import { registerServiceWorker } from "../data/sw.ts";
import { makeQueryClient, makeTrpcClient, TRPCProvider } from "../data/trpc.ts";
import { UiStateProvider } from "../data/ui-state.tsx";
import { fontsHref, stylesheetHref, themeColour } from "../design-system/index.ts";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Household" },
      { name: "theme-color", content: themeColour },
      // HOME-6: installs like an app and opens full screen on the iPad.
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "Household" },
    ],
    links: [
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icon-192.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/icon-apple-touch.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "stylesheet", href: fontsHref },
      { rel: "stylesheet", href: stylesheetHref },
    ],
  }),
  component: Root,
});

function Live() {
  useLive();
  return null;
}

function Root() {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(makeTrpcClient);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return (
    <Doc>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <UiStateProvider>
            {path === "/login" ? null : <Live />}
            <Outlet />
          </UiStateProvider>
        </TRPCProvider>
      </QueryClientProvider>
    </Doc>
  );
}

function Doc({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
