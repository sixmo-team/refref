"use client";
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, type RouterInputs, type RouterOutputs } from "@/trpc/react";
import { getQueryKey } from "@trpc/react-query";
import { SiteBreadcrumbs } from "@/components/site-breadcrumbs";
import { EditableBreadcrumb } from "@/components/editable-breadcrumb";
import { SiteHeader } from "@/components/site-header";
import { SetupCard } from "@/components/program-setup-card";
import { useSidebar } from "@refref/ui/components/sidebar";
import { useWindowSize } from "@uidotdev/usehooks";
import { DesignConfig } from "./_components/design-config";
import { RewardStepConfig } from "./_components/reward-step-config";
// import { NotificationSetup } from "./_components/notification-setup";
import { Installation } from "./_components/installation";
import { canProceedToStep } from "@/lib/program";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Button } from "@refref/ui/components/button";
import { useDeniedRead } from "@/hooks/use-denied-read";

export default function ProgramSetupPage() {
  const params = useParams<{ id: string }>();
  const session = useSession();
  const scope = {
    userId: session.data?.user.id ?? "",
    organizationId: session.data?.session.activeOrganizationId ?? "",
  };
  if (session.isPending) return <p>Loading session…</p>;
  if (session.error || !scope.userId || !scope.organizationId)
    return (
      <div role="alert">
        An active organization session is required.
        {session.error && (
          <Button onClick={() => void session.refetch()}>Retry session</Button>
        )}
      </div>
    );
  return (
    <ProgramDetail
      key={`${scope.userId}:${scope.organizationId}:${params.id}`}
      scope={scope}
    />
  );
}

function ProgramDetail({
  scope,
}: {
  scope: RouterInputs["program"]["getById"]["scope"];
}) {
  const params = useParams<{ id: string }>();

  const query = api.program.getById.useQuery({ id: params.id, scope });
  const rulesQuery = api.rewardRules.getByProgram.useQuery(
    { programId: params.id, scope },
    { enabled: false },
  );
  const utils = api.useUtils();
  const blocked = useDeniedRead({
    scopeKey: `${scope.userId}:${scope.organizationId}:${params.id}`,
    denied:
      query.error?.data?.code === "UNAUTHORIZED" ||
      query.error?.data?.code === "FORBIDDEN" ||
      rulesQuery.error?.data?.code === "UNAUTHORIZED" ||
      rulesQuery.error?.data?.code === "FORBIDDEN",
    queries: [query, rulesQuery],
    reset: (queryClient) => {
      // Denial unmounts nested editors before their own effects can discard data.
      void utils.rewardRules.getByProgram.reset({
        programId: params.id,
        scope,
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(api.productSecrets.get, { scope }, "query"),
      });
      void utils.program.getById.reset({ id: params.id, scope });
    },
    dispose: (queryClient) => {
      queryClient.removeQueries({
        queryKey: getQueryKey(
          api.rewardRules.getByProgram,
          { programId: params.id, scope },
          "query",
        ),
        exact: true,
      });
      queryClient.removeQueries({
        queryKey: getQueryKey(
          api.program.getById,
          { id: params.id, scope },
          "query",
        ),
        exact: true,
      });
    },
  });
  const program = blocked ? undefined : query.data;

  if (blocked || (query.isError && !program))
    return (
      <div role="alert">
        Unable to load program.{" "}
        <Button
          disabled={query.isFetching || rulesQuery.isFetching}
          onClick={() => {
            void query.refetch();
            void rulesQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (!program) {
    return (
      <div className="flex flex-1 items-center justify-center min-h-screen">
        <Loader2 className="animate-spin w-8 h-8 text-muted-foreground" />
        <span className="ml-3 text-muted-foreground">Loading program...</span>
      </div>
    );
  }
  return <ProgramEditor scope={scope} program={program} />;
}

function ProgramEditor({
  scope,
  program,
}: {
  scope: RouterInputs["program"]["getById"]["scope"];
  program: RouterOutputs["program"]["getById"];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const step = searchParams?.get("step") || "installation";
  const { width } = useWindowSize();
  const { open, setOpen } = useSidebar();
  const utils = api.useUtils();
  const updateName = api.program.updateName.useMutation({
    onSettled: (_result, _error, variables) => {
      void utils.program.getById.invalidate({ id: variables.id, scope });
      void utils.program.getAll.invalidate();
    },
  });

  // Redirect to setup if program is not configured yet
  useEffect(() => {
    if (program.status === "pending_setup") {
      router.replace(`/programs/${program.id}/setup`);
    }
  }, [program.id, program.status, router]);
  useEffect(() => {
    if (width && width < 1024 && open) {
      setOpen(false);
    }
  }, [width, open, setOpen]);

  const handleNameUpdate = async (newName: string) => {
    await updateName.mutateAsync(
      { id: program.id, name: newName },
      {
        onSuccess: () => {
          toast.success("Program name updated");
        },
        onError: (error) =>
          toast.error(error.message || "Failed to update program name"),
      },
    );
  };

  const breadcrumbs = [
    { label: "Programs", href: "/programs" },
    {
      label: program.name,
      href: `/programs/${program.id}`,
      editable: true,
      onEdit: handleNameUpdate,
    },
  ];

  const handleStepChange = (stepId: string) => {
    if (!canProceedToStep(stepId, program.config)) {
      toast.error("Please complete the previous required steps first");
      return;
    }
    router.push(`/programs/${program.id}?step=${stepId}`);
  };

  return (
    <>
      <SiteHeader breadcrumbs={<SiteBreadcrumbs items={breadcrumbs} />} />
      <div className="flex flex-1 relative overflow-hidden">
        <div className="absolute top-0 left-0 bottom-0 w-40 border-r bg-muted/40">
          <div className="px-2 py-4 space-y-1">
            {program.setup.steps.map((s) => (
              <SetupCard
                key={s.id}
                title={s.title}
                onClick={() => handleStepChange(s.id)}
                isActive={step === s.id}
              />
            ))}
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-y-auto ml-40">
          {step === "design" && (
            <DesignConfig programId={program.id} scope={scope} />
          )}
          {step === "rewards" && (
            <RewardStepConfig programId={program.id} scope={scope} />
          )}
          {/* {step === "notifications" && (
            <NotificationSetup
              programId={program.id}
              scope={scope}
            />
          )} */}
          {step === "installation" && (
            <Installation programId={program.id} scope={scope} />
          )}
        </div>
      </div>
    </>
  );
}
