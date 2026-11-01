"use client";
import { inputRefcodeSchema } from "@refref/types";
import { api } from "@/trpc/react";
import { useDebounce } from "@/lib/hooks/use-debounce";

export type PartnerCodeAvailability = {
  code: string;
  status:
    "empty" | "invalid" | "checking" | "available" | "taken" | "unavailable";
  canSubmit: boolean;
  retry: () => Promise<unknown>;
};
export function usePartnerCode({
  userId,
  programId,
  value,
  enabled = true,
}: {
  userId: string;
  programId: string;
  value: string;
  enabled?: boolean;
}): PartnerCodeAvailability {
  const parsed = inputRefcodeSchema.safeParse(value);
  const code = parsed.success ? parsed.data : "";
  const debounced = useDebounce(code, 300);
  const query = api.participantPortal.codeAvailability.useQuery(
    {
      userId,
      programId,
      code: debounced,
    },
    {
      enabled:
        enabled && !!userId && !!programId && !!code && code === debounced,
      retry: false,
    },
  );
  let status: PartnerCodeAvailability["status"];
  if (!value.trim()) status = "empty";
  else if (!parsed.success) status = "invalid";
  else if (code !== debounced || query.isFetching || query.isPending)
    status = "checking";
  else if (query.isError)
    status =
      query.error.data?.code === "BAD_REQUEST" ? "invalid" : "unavailable";
  else if (query.data?.code !== code) status = "unavailable";
  else status = query.data.available ? "available" : "taken";
  return {
    code,
    status,
    canSubmit: enabled && status === "available",
    retry: query.refetch,
  };
}
