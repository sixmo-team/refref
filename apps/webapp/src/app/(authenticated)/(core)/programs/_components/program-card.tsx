"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Clock,
  PauseCircle,
  Settings,
  Users,
  Link2,
  TrendingUp,
  MoreVertical,
  BarChart,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@refref/ui/components/card";
import { Button } from "@refref/ui/components/button";
import { Badge } from "@refref/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@refref/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from "@refref/ui/components/alert-dialog";
import { DateDisplay } from "@/components/date-display";
import { api, type RouterInputs, type RouterOutputs } from "@/trpc/react";

type Program = RouterOutputs["program"]["getAll"][number];

interface ProgramCardProps {
  program: Program;
  scope: Exclude<RouterInputs["program"]["getAll"], void>["scope"];
  canManage: boolean;
}

// Individual card component
export function ProgramCard({ program, scope, canManage }: ProgramCardProps) {
  const router = useRouter();
  const utils = api.useUtils();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const deleteProgram = api.program.delete.useMutation({
    onSettled: (_result, _error, variables) => {
      void utils.program.getById.invalidate({
        id: variables.id,
        scope: {
          userId: scope.userId,
          organizationId: scope.organizationId,
        },
      });
      void utils.rewardRules.getByProgram.invalidate({
        programId: variables.id,
        scope: {
          userId: scope.userId,
          organizationId: scope.organizationId,
        },
      });
      void utils.program.getAll.invalidate();
    },
  });

  // Status badge styling and content based on status
  const getStatusBadge = (status: Program["status"]) => {
    switch (status) {
      case "active":
        return (
          <Badge
            variant="outline"
            className="bg-green-100 text-green-800 hover:bg-green-200 border-green-200"
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            Active
          </Badge>
        );
      case "pending_setup":
      case "pending_approval":
        return (
          <Badge
            variant="outline"
            className="bg-amber-50 text-amber-800 hover:bg-amber-100 border-amber-200"
          >
            <Clock className="w-3.5 h-3.5 mr-1" />
            {status === "pending_setup" ? "Setup Pending" : "Approval Required"}
          </Badge>
        );
      case "inactive":
        return (
          <Badge
            variant="secondary"
            className="bg-slate-100 text-slate-800 hover:bg-slate-200"
          >
            <PauseCircle className="w-3.5 h-3.5 mr-1" />
            Inactive
          </Badge>
        );
      case "archived":
        return <Badge variant="secondary">Archived</Badge>;
      default:
        return null;
    }
  };

  const handleCardClick = () => {
    if (program.status === "pending_setup") {
      router.push(`/programs/${program.id}/setup`);
    } else {
      router.push(`/programs/${program.id}`);
    }
  };

  const conversionRate =
    program.participantCount && program.participantCount > 0
      ? (
          ((program.referralCount || 0) / program.participantCount) *
          100
        ).toFixed(1)
      : "0";

  return (
    <Card
      onClick={handleCardClick}
      className="transition-all duration-200 hover:shadow-md cursor-pointer flex flex-col"
    >
      <CardHeader>
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <CardTitle className="text-lg font-semibold">
                {program.name}
              </CardTitle>
              {getStatusBadge(program.status)}
            </div>
            <CardDescription className="mt-1">
              Created <DateDisplay date={program.createdAt} />
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {program.status !== "pending_setup" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/programs/${program.id}`);
                    }}
                  >
                    <BarChart className="mr-2 h-4 w-4" />
                    View Analytics
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/programs/${program.id}?step=installation`);
                    }}
                  >
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </DropdownMenuItem>
                  {canManage && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteDialogOpen(true);
                        }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Remove program
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-grow">
        {program.status === "active" && (
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Participants
              </span>
              <span className="text-sm font-semibold">
                {program.participantCount || 0}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Referrals</span>
              <span className="text-sm font-semibold">
                {program.referralCount || 0}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Conversion Rate
              </span>
              <span className="text-sm font-semibold">{conversionRate}%</span>
            </div>
          </div>
        )}

        {program.status === "pending_setup" && (
          <p className="text-sm text-muted-foreground">
            Complete the setup to activate your referral program
          </p>
        )}

        {program.status === "inactive" && (
          <p className="text-sm text-muted-foreground">
            This program is currently inactive
          </p>
        )}
      </CardContent>

      {program.status === "pending_setup" && (
        <CardFooter className="justify-end">
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/programs/${program.id}/setup`);
            }}
          >
            <Settings className="w-4 h-4 mr-2" />
            Continue Setup
          </Button>
        </CardFooter>
      )}

      <AlertDialog
        open={canManage && deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Program</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &quot;{program.name}&quot;? Programs with codes or history are
              archived; empty programs are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() =>
                deleteProgram.mutate(
                  { id: program.id },
                  {
                    onSuccess: () => {
                      setDeleteDialogOpen(false);
                    },
                  },
                )
              }
              disabled={deleteProgram.isPending}
            >
              {deleteProgram.isPending ? "Removing..." : "Confirm removal"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
