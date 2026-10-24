"use client";
import { SiteHeader } from "@/components/site-header";
import { SiteBreadcrumbs } from "@/components/site-breadcrumbs";
import { ParticipantCard } from "@/components/participant-card";
import { useParams } from "next/navigation";
import { api } from "@/trpc/react";
import { Skeleton } from "@refref/ui/components/skeleton";
import { Alert, AlertDescription } from "@refref/ui/components/alert";
import { AlertCircle } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Button } from "@refref/ui/components/button";
import { useDeniedRead } from "@/hooks/use-denied-read";

export default function ParticipantPage() {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const userId =
    !session.isPending && !session.error ? (session.data?.user.id ?? "") : "";
  const organizationId = userId
    ? (session.data?.session.activeOrganizationId ?? "")
    : "";
  const scope = { userId, organizationId };
  const participantQuery = api.participants.getById.useQuery(
    { id, scope },
    { enabled: !!userId && !!organizationId },
  );
  const utils = api.useUtils();
  const blocked = useDeniedRead({
    scopeKey: JSON.stringify([userId, organizationId, id]),
    denied:
      participantQuery.error?.data?.code === "UNAUTHORIZED" ||
      participantQuery.error?.data?.code === "FORBIDDEN",
    queries: [participantQuery],
    reset: () => void utils.participants.getById.reset({ id, scope }),
  });
  const { isLoading, error } = participantQuery;
  const participant =
    userId && organizationId && !blocked && !error
      ? participantQuery.data
      : undefined;

  const breadcrumbs = [
    { label: "Participants", href: "/participants" },
    {
      label: participant?.name || participant?.email || "Participant",
      href: `/participants/${id}`,
    },
  ];

  if (!blocked && (session.isPending || isLoading)) {
    return (
      <>
        <SiteHeader breadcrumbs={<SiteBreadcrumbs items={breadcrumbs} />} />
        <div className="flex-1 overflow-auto">
          <div className="p-4 lg:p-6 space-y-6">
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </>
    );
  }

  if (!userId || !organizationId || blocked || error) {
    return (
      <>
        <SiteHeader breadcrumbs={<SiteBreadcrumbs items={breadcrumbs} />} />
        <div className="flex-1 overflow-auto">
          <div className="p-4 lg:p-6 space-y-6">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Failed to load verified participant data. {error?.message}
                <Button
                  onClick={() =>
                    void (userId && organizationId
                      ? participantQuery.refetch()
                      : session.refetch())
                  }
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        </div>
      </>
    );
  }

  if (!participant) {
    return (
      <>
        <SiteHeader breadcrumbs={<SiteBreadcrumbs items={breadcrumbs} />} />
        <div className="flex-1 overflow-auto">
          <div className="p-4 lg:p-6 space-y-6">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>Participant not found.</AlertDescription>
            </Alert>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <SiteHeader breadcrumbs={<SiteBreadcrumbs items={breadcrumbs} />} />
      <div className="flex-1 overflow-auto">
        <div className="p-4 lg:p-6 space-y-6">
          <ParticipantCard
            key={`${userId}:${organizationId}:${participant.productId}:${participant.id}:${participant.refcode?.id ?? ""}`}
            participant={participant}
            scope={scope}
          />
        </div>
      </div>
    </>
  );
}
