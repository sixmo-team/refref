import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@refref/ui/components/data-table/data-table-column-header";
import { MoreHorizontal, CheckCircle, XCircle, DollarSign } from "lucide-react"; // Icons
import { Button } from "@refref/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@refref/ui/components/dropdown-menu";
import { api } from "@/trpc/react"; // For calling mutations
import { toast } from "sonner"; // For notifications
import { DateDisplay } from "@/components/date-display";
import { useRef } from "react";
import Link from "next/link";
import type { RouterOutputs, RouterInputs } from "@/trpc/react";

export type Reward = Omit<
  RouterOutputs["rewards"]["getAll"]["data"][number],
  "createdAt" | "updatedAt" | "disbursedAt"
> & { createdAt: string; updatedAt: string; disbursedAt: string | null };

export function getRewardsTableColumns(
  isAdmin: boolean,
  scope: RouterInputs["rewards"]["getAll"]["scope"],
): ColumnDef<Reward>[] {
  const columns: ColumnDef<Reward>[] = [
    {
      accessorKey: "eventType",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Event Type" />
      ),
      cell: ({ row }) => row.getValue("eventType") || "-",
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Event Type",
        variant: "text",
      },
    },
    {
      accessorKey: "rewardType",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Reward Type" />
      ),
      cell: ({ row }) => row.getValue("rewardType"),
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Reward Type",
        variant: "text", // Assuming text filter for rewardType
      },
    },
    {
      accessorKey: "amount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Amount" />
      ),
      cell: ({ row }) => {
        const amount = parseFloat(row.getValue("amount"));
        const currency = row.getValue("currency") as string | null;
        const formatted = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: currency || "USD", // Default to USD if no currency
        }).format(amount);
        return currency ? formatted : amount.toString(); // Show formatted if currency exists
      },
      enableSorting: true,
      enableColumnFilter: false, // Filtering on amount might need a number input
    },
    {
      accessorKey: "currency",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Currency" />
      ),
      cell: ({ row }) => row.getValue("currency"),
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Currency",
        variant: "text",
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => row.getValue("status"),
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Status",
        variant: "text", // Or perhaps a select/enum filter if statuses are fixed
      },
    },
    {
      accessorKey: "participantEmail",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Participant Email" />
      ),
      cell: ({ row }) => row.getValue("participantEmail") || "-",
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Participant Email",
        variant: "text",
      },
    },
    {
      accessorKey: "participantExternalId",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="External ID" />
      ),
      cell: ({ row }) => row.getValue("participantExternalId") || "-",
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "External ID",
        variant: "text",
      },
    },
    {
      accessorKey: "eventId",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Event ID" />
      ),
      cell: ({ row }) => row.getValue("eventId") || "-",
      enableSorting: false,
      enableColumnFilter: true,
      meta: {
        label: "Event ID",
        variant: "text",
      },
    },
    {
      accessorKey: "disbursedAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Disbursed At" />
      ),
      cell: ({ row }) => {
        const disbursedAt = row.getValue("disbursedAt");
        return disbursedAt ? (
          <DateDisplay date={disbursedAt as string} />
        ) : (
          <span className="text-muted-foreground italic">N/A</span>
        );
      },
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Disbursed At",
        variant: "date",
      },
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Created At" />
      ),
      cell: ({ row }) => <DateDisplay date={row.getValue("createdAt")} />,
      enableSorting: true,
      enableColumnFilter: true,
      meta: {
        label: "Created At",
        variant: "date",
      },
    },
    {
      id: "actions",
      header: () => <div className="text-right">Actions</div>,
      cell: function RewardActionsCell({ row }) {
        const reward = row.original;
        const utils = api.useUtils(); // For invalidating queries
        const busy = useRef(false);

        const resourceOptions = {
          onMutate: () => scope,
          onSettled: (
            _data: unknown,
            _error: unknown,
            input: RouterInputs["rewards"]["markAsDisbursed"],
            originatingScope:
              RouterInputs["rewards"]["getAll"]["scope"] | undefined,
          ) => {
            if (!originatingScope) return;
            void utils.rewards.getAll.invalidate({
              scope: { ...originatingScope, productId: input.productId },
            });
            void utils.participantPortal.summary.invalidate({
              productId: input.productId,
            });
            void utils.participantPortal.history.invalidate({
              productId: input.productId,
            });
          },
        };
        const approval =
          api.rewards.updateApprovalStatus.useMutation(resourceOptions);
        const isUpdatingApproval = approval.isPending;
        const updateApproval = (
          input: RouterInputs["rewards"]["updateApprovalStatus"],
        ) =>
          approval.mutate(input, {
            onSettled: () => {
              busy.current = false;
            },
            onSuccess: (data) => {
              toast.success(
                `Reward ${data.rewardId} status updated to ${data.status}`,
              );
            },
            onError: (error) => {
              toast.error(
                `Failed to update status: ${error.message || "Unknown error"}`,
              );
            },
          });

        const disbursement =
          api.rewards.markAsDisbursed.useMutation(resourceOptions);
        const isMarkingDisbursed = disbursement.isPending;
        const markDisbursed = (
          input: RouterInputs["rewards"]["markAsDisbursed"],
        ) =>
          disbursement.mutate(input, {
            onSettled: () => {
              busy.current = false;
            },
            onSuccess: (data) => {
              toast.success(`Reward ${data.rewardId} marked as disbursed.`);
            },
            onError: (error) => {
              toast.error(
                `Failed to mark as disbursed: ${
                  error.message || "Unknown error"
                }`,
              );
            },
          });

        const canApprove =
          reward.status !== "approved" &&
          reward.status !== "disbursed" &&
          reward.status !== "rejected";
        const canReject =
          reward.status !== "rejected" && reward.status !== "disbursed";
        const canMarkDisbursed =
          reward.status === "approved" && !reward.payoutManaged;

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
                {canApprove && (
                  <DropdownMenuItem
                    onClick={() => {
                      if (busy.current) return;
                      busy.current = true;
                      updateApproval({
                        productId: reward.productId,
                        rewardId: reward.id,
                        status: "approved",
                      });
                    }}
                    disabled={isUpdatingApproval}
                  >
                    <CheckCircle className="mr-2 h-4 w-4 text-green-500" />
                    Approve Reward
                  </DropdownMenuItem>
                )}
                {canReject && (
                  <DropdownMenuItem
                    onClick={() => {
                      if (busy.current) return;
                      busy.current = true;
                      updateApproval({
                        productId: reward.productId,
                        rewardId: reward.id,
                        status: "rejected",
                      });
                    }}
                    disabled={isUpdatingApproval}
                  >
                    <XCircle className="mr-2 h-4 w-4 text-red-500" />
                    Reject Reward
                  </DropdownMenuItem>
                )}
                {canMarkDisbursed && (
                  <DropdownMenuItem
                    onClick={() => {
                      if (busy.current) return;
                      busy.current = true;
                      markDisbursed({
                        productId: reward.productId,
                        rewardId: reward.id,
                      });
                    }}
                    disabled={isMarkingDisbursed}
                  >
                    <DollarSign className="mr-2 h-4 w-4 text-blue-500" />
                    Mark as Disbursed
                  </DropdownMenuItem>
                )}
                {reward.payoutManaged && (
                  <DropdownMenuItem asChild>
                    <Link
                      href={`/payouts?productId=${encodeURIComponent(reward.productId)}`}
                    >
                      Manage payout requests
                    </Link>
                  </DropdownMenuItem>
                )}
                {!canApprove && !canReject && !canMarkDisbursed && (
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
    },
  ];
  return columns.filter((column) => column.id !== "actions" || isAdmin);
}
