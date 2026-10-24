"use client";

import * as React from "react";
import { useState, useMemo } from "react";
import { api } from "@/trpc/react";
import { getQueryKey } from "@trpc/react-query";
import { getRewardsTableColumns, type Reward } from "./rewards-table-columns"; // Adjusted import
import { DataTable } from "@refref/ui/components/data-table/data-table";
import { DataTableToolbar } from "@refref/ui/components/data-table/data-table-toolbar";
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState, // Corrected import for SortingState
} from "@tanstack/react-table";
import { Skeleton } from "@refref/ui/components/skeleton";
import { Button } from "@refref/ui/components/button";
import { DataTableFilterMenu } from "@refref/ui/components/data-table/data-table-filter-menu";
import { DataTableSortList } from "@refref/ui/components/data-table/data-table-sort-list";
import { DataTableAdvancedToolbar } from "@refref/ui/components/data-table/data-table-advanced-toolbar";
import { useQueryState } from "nuqs";
import { getFiltersStateParser } from "@refref/ui/lib/parsers";
import { AuthorizedProductScope } from "@/components/authorized-product-scope";
import { useDeniedRead } from "@/hooks/use-denied-read";

export function RewardsTable() {
  return (
    <AuthorizedProductScope>
      {(scope, isAdmin) => (
        <RewardsTableForScope scope={scope} isAdmin={isAdmin} />
      )}
    </AuthorizedProductScope>
  );
}
function RewardsTableForScope({
  scope,
  isAdmin,
}: {
  scope: { organizationId: string; userId: string; productId: string };
  isAdmin: boolean;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true }, // Default sort
  ]);

  const columns = useMemo(
    () => getRewardsTableColumns(isAdmin, scope),
    [isAdmin, scope],
  );

  const [filters] = useQueryState(
    "filters", // URL query param for filters
    getFiltersStateParser(
      columns.map((column) =>
        "accessorKey" in column
          ? String(column.accessorKey)
          : (column.id ?? ""),
      ),
    ).withDefault([]),
  );
  React.useEffect(() => {
    setPageIndex(0);
  }, [filters, sorting, pageSize]);

  const rewards = api.rewards.getAll.useQuery(
    {
      scope,
      page: pageIndex + 1,
      pageSize,
      filters, // Pass filters from URL state
      sort: sorting[0]
        ? {
            field: sorting[0].id as  // Type assertion for sort field
              | "rewardType"
              | "amount"
              | "currency"
              | "status"
              | "createdAt"
              | "disbursedAt",
            direction: sorting[0].desc ? "desc" : "asc",
          }
        : undefined,
    },
    {
      placeholderData: (prev) => prev, // Keep previous data while loading new
    },
  );
  const { isLoading, isError, error, refetch, isFetching } = rewards;
  const blocked = useDeniedRead({
    scopeKey: JSON.stringify([
      scope.userId,
      scope.organizationId,
      scope.productId,
    ]),
    denied:
      error?.data?.code === "UNAUTHORIZED" || error?.data?.code === "FORBIDDEN",
    queries: [rewards],
    reset: (queryClient) =>
      void queryClient.resetQueries({
        queryKey: getQueryKey(api.rewards.getAll, { scope }, "query"),
      }),
  });
  const data = blocked ? undefined : rewards.data;

  // Ensure data types are consistent for the table (e.g., dates to strings)
  const rewardsData: Reward[] = (data?.data ?? []).map((r) => ({
    ...r,
    amount: r.amount?.toString() ?? null, // Ensure amount is string or null
    disbursedAt:
      r.disbursedAt instanceof Date
        ? r.disbursedAt.toISOString()
        : r.disbursedAt,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt:
      r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  }));

  const table = useReactTable<Reward>({
    data: rewardsData,
    columns,
    pageCount: data ? Math.ceil(data.total / pageSize) : -1,
    state: {
      pagination: { pageIndex, pageSize },
      sorting,
    },
    manualPagination: true,
    manualSorting: true,
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater({ pageIndex, pageSize })
          : updater;
      setPageIndex(next.pageIndex);
      setPageSize(next.pageSize);
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  if (blocked)
    return (
      <div role="alert">
        Rewards access denied.{" "}
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <DataTableAdvancedToolbar table={table}>
        <DataTableSortList table={table} align="start" />
        <DataTableFilterMenu table={table} />
      </DataTableAdvancedToolbar>
      {isLoading && !data ? (
        <Skeleton className="h-64 w-full" />
      ) : isError && !data ? (
        <div role="alert" className="text-destructive">
          Failed to load rewards.{" "}
          <Button
            variant="outline"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <DataTable table={table}></DataTable>
      )}
      {isError && data && (
        <p role="alert" className="text-destructive">
          Reward refresh failed. Showing current saved rows.
        </p>
      )}
    </div>
  );
}
