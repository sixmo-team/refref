"use client";

import { api, type RouterInputs } from "@/trpc/react";
import { useActiveMember } from "@/lib/auth-client";
import { Button } from "@refref/ui/components/button";
import { Skeleton } from "@refref/ui/components/skeleton";
import { InstallationStep } from "./installation-step";
import { CredentialsCard } from "./credentials-card";
import { getQueryKey } from "@trpc/react-query";
import { useDeniedRead } from "@/hooks/use-denied-read";

interface InstallationProps {
  programId: string;
  scope: RouterInputs["program"]["getById"]["scope"];
}

export function Installation({ programId, scope }: InstallationProps) {
  const member = useActiveMember();
  const isAdmin =
    !member.isPending &&
    !member.isRefetching &&
    !member.error &&
    member.data?.userId === scope.userId &&
    member.data?.organizationId === scope.organizationId &&
    (member.data.role === "admin" || member.data.role === "owner");
  return (
    <div className="p-4 lg:p-6 space-y-4">
      {isAdmin ? (
        <InstallationCredentials
          key={`${scope.userId}:${scope.organizationId}:${programId}`}
          programId={programId}
          scope={scope}
        />
      ) : (
        <div role="alert">
          Administrator membership is required to view credentials.{" "}
          <Button
            disabled={member.isPending}
            onClick={() => void member.refetch()}
          >
            Retry membership
          </Button>
        </div>
      )}
      <InstallationStep
        step={1}
        title="Integrate Referral UI Elements"
        description="Add the necessary RefRef components or snippets to display referral links, forms, or dashboards within your application."
        docsUrl="https://refref.ai/docs/platform/widget#installation"
      />
      <InstallationStep
        step={2}
        title="Integrate Attribution Script"
        description="Add the RefRef attribution script to your landing pages and signup flow to track referred users."
        docsUrl="https://refref.ai/docs/platform/attribution-script#installation"
      />
    </div>
  );
}

function InstallationCredentials({ programId, scope }: InstallationProps) {
  const program = api.program.getById.useQuery({ id: programId, scope });
  const denied =
    program.error?.data?.code === "UNAUTHORIZED" ||
    program.error?.data?.code === "FORBIDDEN";
  const secrets = api.productSecrets.get.useQuery(
    { productId: program.data?.productId ?? "", scope },
    { enabled: !!program.data?.productId && !denied },
  );
  const blocked = useDeniedRead({
    scopeKey: JSON.stringify([scope.userId, scope.organizationId, programId]),
    denied:
      secrets.error?.data?.code === "UNAUTHORIZED" ||
      secrets.error?.data?.code === "FORBIDDEN",
    queries: [secrets],
    reset: (queryClient) =>
      void queryClient.resetQueries({
        queryKey: getQueryKey(api.productSecrets.get, { scope }, "query"),
      }),
  });
  if (blocked || program.isError || secrets.isError)
    return (
      <div role="alert">
        Unable to load installation credentials.{" "}
        <Button
          disabled={program.isFetching || secrets.isFetching}
          onClick={() => {
            void program.refetch();
            if (program.data && !denied) void secrets.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (!program.data || !secrets.data)
    return <Skeleton className="h-48 w-full" />;
  return (
    <CredentialsCard
      productId={program.data.productId}
      programId={programId}
      clientId={secrets.data.clientId}
      clientSecret={secrets.data.clientSecret}
    />
  );
}
