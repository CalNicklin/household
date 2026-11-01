import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { ViewsRouter } from "../../../server/views/router.ts";

/** PRV-6: any 401 from the server means the session is gone; go and log in again. */
function toLogin(): void {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
}

export const authFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, credentials: "same-origin" });
  if (res.status === 401) toLogin();
  return res;
};

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache(),
    defaultOptions: { queries: { staleTime: 0, refetchOnWindowFocus: true } },
  });
}

type LinkFetch = NonNullable<Parameters<typeof httpLink>[0]["fetch"]>;

const trpcFetch: LinkFetch = async (url, init) => {
  const res = await fetch(url, {
    credentials: "same-origin",
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body: init?.body ?? null,
    signal: init?.signal ?? null,
  });
  if (res.status === 401) toLogin();
  return res;
};

/** Plain (unbatched) links so each view has its own URL, which the service worker can cache. */
export function makeTrpcClient() {
  return createTRPCClient<ViewsRouter>({ links: [httpLink({ url: "/api/trpc", fetch: trpcFetch })] });
}

export const { TRPCProvider, useTRPC } = createTRPCContext<ViewsRouter>();
