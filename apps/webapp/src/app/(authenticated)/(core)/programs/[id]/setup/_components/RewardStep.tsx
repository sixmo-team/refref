import React, { forwardRef, useImperativeHandle } from "react";
import { api, type RouterInputs } from "@/trpc/react";
import { rewardConfigFromForm, type RewardConfigType } from "@refref/types";
import {
  RewardStepForm,
  DEFAULT_REWARD_FORM,
  useRewardForm,
} from "./RewardStepForm";
import { Button } from "@refref/ui/components/button";
interface RewardStepProps {
  programId: string;
  scope: RouterInputs["program"]["getById"]["scope"];
}
export interface RewardStepRef {
  submitForm: () => Promise<RewardConfigType | undefined>;
}
export const RewardStep = forwardRef<RewardStepRef, RewardStepProps>(
  ({ programId, scope }, ref) => {
    const query = api.program.getById.useQuery({ id: programId, scope });
    const program =
      query.error?.data?.code === "UNAUTHORIZED" ||
      query.error?.data?.code === "FORBIDDEN"
        ? undefined
        : query.data;
    const form = useRewardForm(DEFAULT_REWARD_FORM);
    useImperativeHandle(ref, () => ({
      submitForm: async () => {
        await form.validateAllFields("submit");
        if (!program || form.state.isValidating || !form.state.isValid)
          throw new Error("Reward configuration is invalid");
        return rewardConfigFromForm(
          form.state.values,
          program.programTemplateId,
        );
      },
    }));
    if (query.isError && !program)
      return (
        <div role="alert">
          Unable to load reward settings.{" "}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </div>
      );
    return (
      <div className="max-w-3xl mx-auto space-y-6 p-4">
        {program ? (
          <RewardStepForm form={form} templateId={program.programTemplateId} />
        ) : (
          <p>Loading reward settings…</p>
        )}
      </div>
    );
  },
);
RewardStep.displayName = "RewardStep";
