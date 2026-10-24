import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";

import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";
import { env } from "@/env";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a HTTP request (e.g. when you make requests from Client Components).
 */
const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

const handler = (req: NextRequest) => {
  if (
    req.method === "POST" &&
    req.headers.get("origin") !== new URL(env.NEXT_PUBLIC_APP_URL).origin
  ) {
    return new Response(
      JSON.stringify({ error: "Forbidden", code: "INVALID_ORIGIN" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    allowMethodOverride: true,
    createContext: () => createContext(req),
  });
};

export { handler as GET, handler as POST };
