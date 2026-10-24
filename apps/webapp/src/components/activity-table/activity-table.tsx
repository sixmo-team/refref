"use client";

import * as React from "react";
import { useState, useMemo } from "react";
import { api } from "@/trpc/react";
import { getQueryKey } from "@trpc/react-query";
import {
  getActivityTableColumns,
  type Activity,
} from "./activity-table-columns";
import { DataTable } from "@refref/ui/components/data-table/data-table";
import { DataTableToolbar } from "@refref/ui/components/data-table/data-table-toolbar";
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
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

export function ActivityTable() {
  return (
    <AuthorizedProductScope>
      {(scope, isAdmin) => (
        <ActivityTableForScope scope={scope} isAdmin={isAdmin} />
      )}
    </AuthorizedProductScope>
  );
}
function ActivityTableForScope({
  scope,
  isAdmin,
}: {
  scope: { organizationId: string; userId: string; productId: string };
  isAdmin: boolean;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);

  const columns = useMemo(
    () => getActivityTableColumns(isAdmin, scope),
    [isAdmin, scope],
  );

  const [filters] = useQueryState(
    "filters",
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

  const activity = api.events.getAll.useQuery(
    {
      scope,
      page: pageIndex + 1,
      pageSize,
      filters,
      sort: sorting[0]
        ? {
            field: sorting[0].id as "eventType" | "status" | "createdAt",
            direction: sorting[0].desc ? "desc" : "asc",
          }
        : undefined,
    },
    {
      placeholderData: (prev) => prev,
    },
  );
  const { isLoading, isError, error, refetch, isFetching } = activity;
  const blocked = useDeniedRead({
    scopeKey: JSON.stringify([
      scope.userId,
      scope.organizationId,
      scope.productId,
    ]),
    denied:
      error?.data?.code === "UNAUTHORIZED" || error?.data?.code === "FORBIDDEN",
    queries: [activity],
    reset: (queryClient) =>
      void queryClient.resetQueries({
        queryKey: getQueryKey(api.events.getAll, { scope }, "query"),
      }),
  });
  const data = blocked ? undefined : activity.data;

  const activityData: Activity[] = (data?.data ?? []).map((e) => ({
    ...e,
    createdAt:
      e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
    updatedAt:
      e.updatedAt instanceof Date ? e.updatedAt.toISOString() : e.updatedAt,
  }));

  const table = useReactTable<Activity>({
    data: activityData,
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
        Activity access denied.{" "}
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
          Failed to load activity.{" "}
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
          Activity refresh failed. Showing current saved rows.
        </p>
      )}
    </div>
  );
}
