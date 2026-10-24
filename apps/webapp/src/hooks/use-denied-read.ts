"use client";

import { useEffect, useRef, useState } from "react";
import {
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";

// A denied financial snapshot is discarded, not revived by a later transport error.
// Reopening requires successful native reads, never placeholder data.
export function useDeniedRead({
  scopeKey,
  denied,
  queries,
  reset,
  dispose,
}: {
  scopeKey: string;
  denied: boolean;
  queries: readonly Pick<
    UseQueryResult<unknown, unknown>,
    "isSuccess" | "isPlaceholderData" | "dataUpdatedAt" | "failureReason"
  >[];
  reset: (queryClient: QueryClient) => void;
  dispose?: (queryClient: QueryClient) => void;
}) {
  const queryClient = useQueryClient();
  const accessDenied =
    denied ||
    queries.some(
      ({ failureReason }) =>
        failureReason instanceof TRPCClientError &&
        (failureReason.data?.code === "UNAUTHORIZED" ||
          failureReason.data?.code === "FORBIDDEN"),
    );
  const [blockedScope, setBlockedScope] = useState<string | null>(null);
  const blocked = blockedScope === scopeKey;
  const verified = queries.every(
    (query) =>
      query.isSuccess && !query.isPlaceholderData && query.dataUpdatedAt > 0,
  );
  const disposal = useRef<{
    scopeKey: string;
    incomplete: boolean;
    dispose: typeof dispose;
  } | null>(null);
  useEffect(() => {
    return () => {
      const owner = disposal.current;
      if (owner?.scopeKey === scopeKey && owner.incomplete) {
        owner.dispose?.(queryClient);
      }
    };
  }, [scopeKey, queryClient]);
  useEffect(() => {
    // Cleanup sees the old scope's last commit, not a new inline callback.
    disposal.current = {
      scopeKey,
      incomplete: accessDenied || (blocked && !verified),
      dispose,
    };
  });
  useEffect(() => {
    if (accessDenied && !blocked) {
      setBlockedScope(scopeKey);
      reset(queryClient);
    } else if (blocked && !accessDenied && verified) {
      setBlockedScope(null);
    }
  }, [scopeKey, accessDenied, blocked, verified, reset, queryClient]);
  return accessDenied || blocked;
}
