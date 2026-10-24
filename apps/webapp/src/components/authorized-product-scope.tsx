"use client";

import { Fragment, type ReactNode } from "react";
import { useQueryState } from "nuqs";
import { useActiveMember, useSession } from "@/lib/auth-client";
import { api, type RouterInputs } from "@/trpc/react";
import { getQueryKey } from "@trpc/react-query";
import { useDeniedRead } from "@/hooks/use-denied-read";
import { Button } from "@refref/ui/components/button";
import { Skeleton } from "@refref/ui/components/skeleton";

type ProductScope = RouterInputs["events"]["getAll"]["scope"];

export function AuthorizedProductScope({
  children,
  adminOnly = false,
}: {
  children: (scope: ProductScope, isAdmin: boolean) => ReactNode;
  adminOnly?: boolean;
}) {
  const session = useSession();
  const member = useActiveMember();
  const userId = session.data?.user.id ?? "";
  const organizationId = session.data?.session.activeOrganizationId ?? "";
  const products = api.product.getAll.useQuery(
    { userId, organizationId },
    { enabled: !session.isPending && !!userId && !!organizationId },
  );
  const [selection, setSelection] = useQueryState("productId", {
    defaultValue: "",
  });
  const isAdmin =
    !member.isPending &&
    !member.isRefetching &&
    !member.error &&
    member.data?.userId === userId &&
    member.data?.organizationId === organizationId &&
    (member.data.role === "owner" || member.data.role === "admin");
  const utils = api.useUtils();
  const identityScope = { userId, organizationId };
  const denied = useDeniedRead({
    scopeKey: JSON.stringify([userId, organizationId]),
    denied:
      products.error?.data?.code === "UNAUTHORIZED" ||
      products.error?.data?.code === "FORBIDDEN",
    queries: [products],
    reset: (queryClient) => {
      // Discard dependent snapshots explicitly; child barriers may never see this denial.
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.events.getAll,
          { scope: identityScope },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.rewards.getAll,
          { scope: identityScope },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(api.payouts.list, identityScope, "query"),
      });
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
          { scope: identityScope },
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
        queryKey: getQueryKey(
          api.program.getAll,
          { scope: identityScope },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.participants.getById,
          { scope: identityScope },
          "query",
        ),
      });
      // Own participant-portal reads do not depend on organization membership.
      void utils.product.getAll.reset(identityScope);
    },
  });
  if (session.isPending) return <Skeleton className="h-32 w-full" />;
  if (session.error || !userId || !organizationId)
    return (
      <div role="alert">
        Select an organization with an active session.
        {session.error && (
          <Button variant="outline" onClick={() => void session.refetch()}>
            Retry session
          </Button>
        )}
      </div>
    );
  if (adminOnly && !isAdmin)
    return (
      <div role="alert">
        Administrator membership is required.{" "}
        <Button
          variant="outline"
          disabled={member.isPending}
          onClick={() => void member.refetch()}
        >
          Retry membership
        </Button>
      </div>
    );
  const productId =
    !denied && products.data?.some((product) => product.id === selection)
      ? selection
      : "";
  return (
    <div className="space-y-4">
      <label className="flex gap-3 items-center">
        Authorized product
        <select
          className="border rounded p-2"
          value={productId}
          disabled={products.isLoading || denied}
          onChange={(event) => void setSelection(event.target.value)}
        >
          <option value="">Select product explicitly</option>
          {!denied &&
            products.data?.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
        </select>
      </label>
      {(denied || products.isError) && (
        <div role="alert">
          Unable to load authorized products.{" "}
          <Button
            variant="outline"
            disabled={products.isFetching}
            onClick={() => void products.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {!adminOnly && member.error && (
        <div role="alert">
          Administrator controls are unavailable.{" "}
          <Button variant="outline" onClick={() => void member.refetch()}>
            Retry membership
          </Button>
        </div>
      )}
      {products.isLoading && <Skeleton className="h-32 w-full" />}
      {products.data?.length === 0 && !denied && <p>No authorized products.</p>}
      {productId && (
        <Fragment key={`${userId}:${organizationId}:${productId}`}>
          {children({ userId, organizationId, productId }, isAdmin)}
        </Fragment>
      )}
    </div>
  );
}
