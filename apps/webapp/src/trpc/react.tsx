"use client";

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { unstable_httpBatchStreamLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import SuperJSON from "superjson";

import { type AppRouter } from "@/server/api/root";
import { useSession } from "@/lib/auth-client";
import { createQueryClient } from "./query-client";

let clientQueryClientSingleton:
  { scope: string; client: QueryClient } | undefined;
const getQueryClient = (scope: string) => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Retain one browser client across initial Suspense retries, never across owners.
  if (clientQueryClientSingleton?.scope !== scope)
    clientQueryClientSingleton = { scope, client: createQueryClient() };
  return clientQueryClientSingleton.client;
};

export const api = createTRPCReact<AppRouter>() as ReturnType<
  typeof createTRPCReact<AppRouter>
>;

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function TRPCReactProvider(props: { children: React.ReactNode }) {
  const session = useSession();
  const scope = JSON.stringify([
    session.data?.user.id ?? null,
    session.data?.session.activeOrganizationId ?? null,
  ]);
  return (
    <ScopedTRPCReactProvider key={scope} queryClient={getQueryClient(scope)}>
      {props.children}
    </ScopedTRPCReactProvider>
  );
}

function ScopedTRPCReactProvider({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}) {
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        unstable_httpBatchStreamLink({
          transformer: SuperJSON,
          methodOverride: "POST",
          url: getBaseUrl() + "/api/trpc",
          headers: () => {
            const headers = new Headers();
            headers.set("x-trpc-source", "nextjs-react");
            return headers;
          },
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {children}
      </api.Provider>
    </QueryClientProvider>
  );
}

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
