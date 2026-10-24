import { createColumnHelper } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@refref/ui/components/data-table/data-table-column-header";
import { MoreHorizontal, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@refref/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@refref/ui/components/dropdown-menu";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { DateDisplay } from "@/components/date-display";
import { eventMetadataSchema } from "@refref/types";
import type { RouterOutputs, RouterInputs } from "@/trpc/react";

export type Activity = Omit<
  RouterOutputs["events"]["getAll"]["data"][number],
  "createdAt" | "updatedAt"
> & { createdAt: string; updatedAt: string };

const columnHelper = createColumnHelper<Activity>();

export function getActivityTableColumns(
  isAdmin: boolean,
  scope: RouterInputs["events"]["getAll"]["scope"],
) {
  return [
    columnHelper.accessor("eventType", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Event Type" />
      ),
      cell: ({ getValue }) => getValue() || "-",
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Event Type",
        variant: "text",
      },
    }),
    columnHelper.accessor("eventName", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Event Name" />
      ),
      cell: ({ getValue }) => getValue() || "-",
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Event Name",
        variant: "text",
      },
    }),
    columnHelper.accessor("status", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ getValue }) => {
        const status = getValue();
        const statusColors: Record<string, string> = {
          pending: "text-yellow-600",
          processed: "text-green-600",
          failed: "text-red-600",
        };
        return <span className={statusColors[status] || ""}>{status}</span>;
      },
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Status",
        variant: "text",
      },
    }),
    columnHelper.accessor("participantEmail", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Participant" />
      ),
      cell: ({ getValue, row }) => {
        const email = getValue();
        const name = row.original.participantName;
        const externalId = row.original.participantExternalId;

        if (email) {
          return (
            <div>
              <div>{email}</div>
              {name && (
                <div className="text-sm text-muted-foreground">{name}</div>
              )}
            </div>
          );
        } else if (externalId) {
          return (
            <div>
              <div className="text-sm text-muted-foreground">
                ID: {externalId}
              </div>
            </div>
          );
        }
        return "-";
      },
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Participant Email",
        variant: "text",
      },
    }),
    columnHelper.accessor("programName", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Program" />
      ),
      cell: ({ getValue }) => getValue() || "-",
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Program",
        variant: "text",
      },
    }),
    columnHelper.accessor("referralId", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Referral ID" />
      ),
      cell: ({ getValue }) => {
        const referralId = getValue();
        return referralId ? <code className="text-xs">{referralId}</code> : "-";
      },
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Referral ID",
        variant: "text",
      },
    }),
    columnHelper.accessor("metadata", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Metadata" />
      ),
      cell: ({ getValue }) => {
        const parsed = eventMetadataSchema.safeParse(getValue());
        if (!parsed.success) return <span>Unsupported event metadata</span>;
        const metadata = parsed.data;
        const displayItems: string[] = [];
        if (metadata.schemaVersion === 2) {
          displayItems.push(`Order: ${metadata.orderId}`);
          displayItems.push(
            new Intl.NumberFormat("ru-RU", {
              style: "currency",
              currency: metadata.currency,
            }).format(metadata.orderAmountMinor / 100),
          );
          displayItems.push(
            `Code: ${metadata.referralSnapshot.attribution.codeValue}`,
          );
        } else if (metadata.orderAmount !== undefined) {
          const currency =
            typeof metadata.customData?.currency === "string" &&
            /^[A-Z]{3}$/.test(metadata.customData.currency)
              ? metadata.customData.currency
              : "USD";
          displayItems.push(
            new Intl.NumberFormat(undefined, {
              style: "currency",
              currency,
            }).format(metadata.orderAmount),
          );
          if (metadata.orderId) displayItems.push(`Order: ${metadata.orderId}`);
        }
        if (metadata.source) displayItems.push(`Source: ${metadata.source}`);
        displayItems.push(`v${metadata.schemaVersion}`);

        return (
          <div className="text-sm text-muted-foreground">
            {displayItems.join(" • ") ||
              JSON.stringify(metadata).substring(0, 50) + "..."}
          </div>
        );
      },
      enableSorting: false,
      enableColumnFilter: false,
    }),
    columnHelper.accessor("createdAt", {
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Created At" />
      ),
      cell: ({ getValue }) => <DateDisplay date={getValue()} />,
      enableSorting: true,
      enableColumnFilter: false,
      meta: {
        label: "Created At",
        variant: "date",
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const activity = row.original;
        const utils = api.useUtils();

        const mutation = api.events.updateStatus.useMutation({
          onMutate: () => scope,
          onSettled: (_data, _error, _input, originatingScope) => {
            if (!originatingScope) return;
            void utils.events.getAll.invalidate({ scope: originatingScope });
          },
        });
        const isUpdatingStatus = mutation.isPending;
        const updateStatus = (input: RouterInputs["events"]["updateStatus"]) =>
          mutation.mutate(input, {
            onSuccess: (data) => {
              if (data) {
                toast.success(
                  `Event ${data.id} status updated to ${data.status}`,
                );
              }
            },
            onError: (error) => {
              toast.error(
                `Failed to update status: ${error.message || "Unknown error"}`,
              );
            },
          });

        const financial = activity.metadata?.schemaVersion === 2;
        const canProcess = !financial && activity.status === "pending";
        const canRetry = !financial && activity.status === "failed";

        return (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">Open menu</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {canProcess && (
                  <DropdownMenuItem
                    onClick={() =>
                      updateStatus({
                        eventId: activity.id,
                        status: "processed",
                      })
                    }
                    disabled={isUpdatingStatus}
                  >
                    <CheckCircle className="mr-2 h-4 w-4 text-green-500" />
                    Mark as Processed
                  </DropdownMenuItem>
                )}
                {canRetry && (
                  <DropdownMenuItem
                    onClick={() =>
                      updateStatus({
                        eventId: activity.id,
                        status: "pending",
                      })
                    }
                    disabled={isUpdatingStatus}
                  >
                    <RefreshCw className="mr-2 h-4 w-4 text-blue-500" />
                    Retry Processing
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() =>
                    updateStatus({
                      eventId: activity.id,
                      status: "failed",
                    })
                  }
                  disabled={isUpdatingStatus || financial}
                >
                  <XCircle className="mr-2 h-4 w-4 text-red-500" />
                  Mark as Failed
                </DropdownMenuItem>
                {!canProcess &&
                  !canRetry &&
                  activity.status === "processed" && (
                    <DropdownMenuItem disabled>
                      No actions available
                    </DropdownMenuItem>
                  )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
      enableSorting: false,
      enableColumnFilter: false,
    }),
  ].filter((column) => column.id !== "actions" || isAdmin);
}
