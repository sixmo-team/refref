import React from "react";
import { api, type RouterInputs } from "@/trpc/react";
import {
  rewardConfigFromForm,
  currencySchema,
  templateRequiresVerifiedPurchase,
  type ProgramTemplateRewardStepV2Type,
  type RewardConfigType,
} from "@refref/types";
import { toast } from "sonner";
import { StickySaveBarRelative } from "@/components/sticky-save-bar";
import {
  RewardStepForm,
  DEFAULT_REWARD_FORM,
  useRewardForm,
} from "../setup/_components/RewardStepForm";
import { Button } from "@refref/ui/components/button";
import { Input } from "@refref/ui/components/input";
import { useActiveMember } from "@/lib/auth-client";
export function RewardStepConfig({
  programId,
  scope,
}: {
  programId: string;
  scope: RouterInputs["program"]["getById"]["scope"];
}) {
  const programQuery = api.program.getById.useQuery({ id: programId, scope });
  const rulesQuery = api.rewardRules.getByProgram.useQuery({
    programId,
    scope,
  });
  const utils = api.useUtils();
  const blocked =
    programQuery.error?.data?.code === "UNAUTHORIZED" ||
    programQuery.error?.data?.code === "FORBIDDEN" ||
    rulesQuery.error?.data?.code === "UNAUTHORIZED" ||
    rulesQuery.error?.data?.code === "FORBIDDEN";
  const member = useActiveMember();
  const isAdmin =
    !member.isPending &&
    !member.isRefetching &&
    !member.error &&
    member.data?.userId === scope.userId &&
    member.data?.organizationId === scope.organizationId &&
    (member.data.role === "admin" || member.data.role === "owner");
  const save = api.program.saveTemplateConfiguration.useMutation({
    onSettled: (_result, _error, variables) => {
      void utils.program.getById.invalidate({ id: variables.id, scope });
      void utils.rewardRules.getByProgram.invalidate({
        programId: variables.id,
        scope,
      });
      void utils.program.getAll.invalidate();
    },
  });
  const approve = api.program.approveServerTracking.useMutation({
    onSettled: (_result, _error, variables) => {
      void utils.program.getById.invalidate({
        id: variables.programId,
        scope,
      });
      void utils.program.getAll.invalidate();
    },
  });
  const [reviewedVersion, setReviewedVersion] = React.useState<string | null>(
    null,
  );
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );
  const [dates, setDates] = React.useState({ start: "", end: "" });
  const reviewKey = JSON.stringify([
    programQuery.data?.termsFingerprint,
    programQuery.data?.startDate,
    programQuery.data?.endDate,
    dates.start,
    dates.end,
  ]);
  const reviewed =
    !!programQuery.data?.termsFingerprint && reviewedVersion === reviewKey;
  const approvalBusy = React.useRef(false);
  const values = React.useMemo<ProgramTemplateRewardStepV2Type>(() => {
    if (blocked) return DEFAULT_REWARD_FORM;
    const settings = programQuery.data?.config?.rewardConfig;
    if (settings)
      return {
        firstPaidOnly: settings.firstPaidOnly,
        referrerReward: settings.referrer
          ? { enabled: true, ...settings.referrer }
          : DEFAULT_REWARD_FORM.referrerReward,
        refereeReward: settings.referee
          ? { enabled: true, ...settings.referee }
          : DEFAULT_REWARD_FORM.refereeReward,
      };
    // Legacy programs did not persist settings. Read only active native rules without inventing business terms.
    const referrer = rulesQuery.data?.find(
      (r) => r.isActive && r.config.participantType === "referrer",
    );
    const referee = rulesQuery.data?.find(
      (r) => r.isActive && r.config.participantType === "referee",
    );
    const currency = currencySchema.safeParse(referrer?.config.reward.currency);
    const buyerCurrency = currencySchema.safeParse(
      referee?.config.reward.currency,
    );
    return {
      referrerReward: referrer
        ? {
            enabled: true,
            valueType:
              referrer.config.reward.unit === "percent"
                ? "percentage"
                : "fixed",
            value: referrer.config.reward.amount,
            currency: currency.success ? currency.data : "USD",
          }
        : DEFAULT_REWARD_FORM.referrerReward,
      refereeReward: referee
        ? {
            enabled: true,
            valueType:
              referee.config.reward.unit === "percent" ? "percentage" : "fixed",
            value: referee.config.reward.amount,
            currency: buyerCurrency.success ? buyerCurrency.data : undefined,
            minPurchaseAmount: referee.config.reward.minPurchaseAmount,
            validityDays: referee.config.reward.validityDays,
          }
        : DEFAULT_REWARD_FORM.refereeReward,
    };
  }, [blocked, programQuery.data, rulesQuery.data]);
  const form = useRewardForm(values, async (value) => {
    if (!programQuery.data || blocked) return;
    setValidationError(null);
    let rewardConfig: RewardConfigType;
    try {
      rewardConfig = rewardConfigFromForm(
        value,
        programQuery.data.programTemplateId,
      );
    } catch {
      setValidationError(
        "Check enabled rewards: values must be positive, fixed amounts and purchase minimums need at most two decimals (maximum 99,999,999.99), and percentages must be at most 100 with up to six decimals.",
      );
      return;
    }
    save.mutate(
      {
        id: programId,
        templateConfig: { rewardConfig },
      },
      {
        onSuccess: () => {
          form.reset(value);
          toast.success("Reward settings saved");
        },
        onError: (error) =>
          toast.error(error.message || "Failed to save reward settings"),
      },
    );
  });
  React.useEffect(() => {
    if (blocked || !form.state.isDirty) form.reset(values);
    if (blocked) {
      setReviewedVersion(null);
      setDates({ start: "", end: "" });
      setValidationError(null);
    }
  }, [blocked, values, form]);
  const loadError = (blocked || programQuery.isError || rulesQuery.isError) && (
    <div role="alert">
      {blocked
        ? "Reward settings access denied."
        : !programQuery.data || !rulesQuery.data
          ? "Unable to load reward settings."
          : "Unable to refresh reward settings. Your unsaved changes are retained."}{" "}
      <Button
        disabled={programQuery.isFetching || rulesQuery.isFetching}
        onClick={() => {
          void programQuery.refetch();
          void rulesQuery.refetch();
        }}
      >
        Retry
      </Button>
    </div>
  );
  if (blocked || !programQuery.data || !rulesQuery.data)
    return loadError || <p>Loading reward settings…</p>;
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 lg:p-6 overflow-y-auto">
        {loadError}
        {validationError && (
          <p role="alert" className="text-destructive">
            {validationError}
          </p>
        )}
        <RewardStepForm
          form={form}
          templateId={programQuery.data.programTemplateId}
        />
        {member.error && (
          <div role="alert">
            Administrator controls are unavailable.{" "}
            <Button onClick={() => void member.refetch()}>
              Retry membership
            </Button>
          </div>
        )}
        {isAdmin &&
          (programQuery.data.status === "pending_approval" ||
            programQuery.data.config?.serverTracking ||
            programQuery.data.config?.rewardConfig?.firstPaidOnly ||
            templateRequiresVerifiedPurchase(
              programQuery.data.programTemplateId,
            )) && (
            <section className="border rounded p-4 space-y-3">
              <h3>Server-tracked program activation approval</h3>
              <p>
                Calculation v1: exact nonnegative decimals, half-up once to
                minor units. Edge examples: 1 minor × 50% = 1; 3 × 50% = 2; 101
                × 2.5% = 3. Fixed amounts require at most two fractional digits.
                Approval applies only to saved terms; changing them invalidates
                approval.
              </p>
              <p>
                Terms fingerprint:{" "}
                <code>{programQuery.data.termsFingerprint}</code>; status:{" "}
                {programQuery.data.status}
              </p>
              <p>
                Saved period:{" "}
                {programQuery.data.startDate?.toLocaleString() ??
                  "no start limit"}
                {" — "}
                {programQuery.data.endDate?.toLocaleString() ?? "no end limit"}.
                Leave a date blank to keep its saved value.
              </p>
              <label className="block">
                Explicit program start (local; required for a validity period)
                <Input
                  type="datetime-local"
                  value={dates.start}
                  onChange={(e) =>
                    setDates((d) => ({ ...d, start: e.target.value }))
                  }
                />
              </label>
              <label className="block">
                Explicit program end (local; optional)
                <Input
                  type="datetime-local"
                  value={dates.end}
                  onChange={(e) =>
                    setDates((d) => ({ ...d, end: e.target.value }))
                  }
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) =>
                    setReviewedVersion(e.target.checked ? reviewKey : null)
                  }
                />
                I have explicit business approval for these saved rates,
                dates/minimums, commission basis, edge examples and the
                independently verified ownership/recipient policy.
              </label>
              <Button
                disabled={!reviewed || approve.isPending}
                onClick={() => {
                  if (
                    !reviewed ||
                    blocked ||
                    approvalBusy.current ||
                    !programQuery.data?.termsFingerprint
                  )
                    return;
                  approvalBusy.current = true;
                  try {
                    approve.mutate(
                      {
                        productId: programQuery.data.productId,
                        programId,
                        termsFingerprint: programQuery.data.termsFingerprint,
                        reviewedPeriod: {
                          startDate:
                            programQuery.data.startDate?.toISOString() ?? null,
                          endDate:
                            programQuery.data.endDate?.toISOString() ?? null,
                        },
                        calculationVersion: 1,
                        edgeExamplesApproved: true,
                        ownershipPolicyVerified: true,
                        ...(dates.start
                          ? { startDate: new Date(dates.start).toISOString() }
                          : {}),
                        ...(dates.end
                          ? { endDate: new Date(dates.end).toISOString() }
                          : {}),
                      },
                      {
                        onSuccess: () => {
                          setReviewedVersion(null);
                        },
                        onError: (error) =>
                          toast.error(error.message || "Approval failed"),
                        onSettled: () => {
                          approvalBusy.current = false;
                        },
                      },
                    );
                  } catch (error) {
                    approvalBusy.current = false;
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Approval failed",
                    );
                  }
                }}
              >
                Record explicit approval and activate
              </Button>
              {approve.error && <p role="alert">{approve.error.message}</p>}
            </section>
          )}
      </div>
      <form.Subscribe selector={(state) => state.isDirty}>
        {(dirty) => (
          <StickySaveBarRelative
            isDirty={dirty}
            onSave={() => form.handleSubmit()}
            onDiscard={() => {
              setValidationError(null);
              form.reset(values);
            }}
            isSaving={save.isPending}
            saveText="Save reward settings"
            message="You have unsaved reward changes"
          />
        )}
      </form.Subscribe>
    </div>
  );
}
