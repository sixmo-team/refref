"use client";

import { ProgramCard } from "./_components/program-card";
import { CreateProgramModalV2 } from "@/app/_components/create-program-modal";
import { api, type RouterInputs } from "@/trpc/react";
import { SiteHeader } from "@/components/site-header";
import { SiteBreadcrumbs } from "@/components/site-breadcrumbs";
import { AuthorizedProductScope } from "@/components/authorized-product-scope";
import { Button } from "@refref/ui/components/button";
import { Skeleton } from "@refref/ui/components/skeleton";
import { getQueryKey } from "@trpc/react-query";
import { useDeniedRead } from "@/hooks/use-denied-read";

export default function ProgramsPage() {
  return (
    <>
      <SiteHeader
        breadcrumbs={
          <SiteBreadcrumbs items={[{ label: "Programs", href: "/programs" }]} />
        }
      />
      <div className="p-4 lg:p-6 max-w-4xl mx-auto w-full space-y-4">
        <AuthorizedProductScope>
          {(scope, canManage) => (
            <ProgramsForScope scope={scope} canManage={canManage} />
          )}
        </AuthorizedProductScope>
      </div>
    </>
  );
}

function ProgramsForScope({
  scope,
  canManage,
}: {
  scope: Exclude<RouterInputs["program"]["getAll"], void>["scope"];
  canManage: boolean;
}) {
  const programs = api.program.getAll.useQuery({ scope });
  const blocked = useDeniedRead({
    scopeKey: JSON.stringify([
      scope.userId,
      scope.organizationId,
      scope.productId,
    ]),
    denied:
      programs.error?.data?.code === "UNAUTHORIZED" ||
      programs.error?.data?.code === "FORBIDDEN",
    queries: [programs],
    reset: (queryClient) => {
      const identityScope = {
        userId: scope.userId,
        organizationId: scope.organizationId,
      };
      // Program detail/rule keys identify the program, not its product.
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.rewardRules.getByProgram,
          { scope: identityScope },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.productSecrets.get,
          { productId: scope.productId, scope: identityScope },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.program.getById,
          { scope: identityScope },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(api.program.getAll, { scope }, "query"),
      });
    },
  });
  if (blocked)
    return (
      <div role="alert">
        Program access denied.{" "}
        <Button
          disabled={programs.isFetching}
          onClick={() => void programs.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  return (
    <>
      <CreateProgramModalV2 scope={scope} />
      {programs.isLoading && <Skeleton className="h-64 w-full" />}
      {programs.isError && (
        <div role="alert">
          Unable to load programs.{" "}
          <Button
            variant="outline"
            disabled={programs.isFetching}
            onClick={() => void programs.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {programs.data?.length === 0 && (
        <div className="text-center py-12">
          <h3 className="text-lg font-medium">No programs yet</h3>
          <p className="text-muted-foreground">
            Create your first program for this product.
          </p>
        </div>
      )}
      {programs.data?.map((program) => (
        <ProgramCard
          key={program.id}
          scope={scope}
          canManage={canManage}
          program={program}
        />
      ))}
    </>
  );
}
