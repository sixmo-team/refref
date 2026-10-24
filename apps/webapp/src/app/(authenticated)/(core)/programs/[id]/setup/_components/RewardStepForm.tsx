import React from "react";
import { useForm, type ReactFormExtendedApi } from "@tanstack/react-form";
import { Input } from "@refref/ui/components/input";
import { Label } from "@refref/ui/components/label";
import { Switch } from "@refref/ui/components/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@refref/ui/components/card";
import {
  RewardCurrencies,
  RewardCurrencyLabels,
  RewardCurrencySymbols,
  currencySchema,
  programTemplateRewardStepSchemaV2,
  getTemplateRewardModule,
  type ProgramTemplateRewardStepV2Type,
} from "@refref/types";

export type RewardForm = ReactFormExtendedApi<
  ProgramTemplateRewardStepV2Type,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  typeof programTemplateRewardStepSchemaV2,
  undefined,
  undefined,
  undefined,
  undefined,
  unknown
>;
export const DEFAULT_REWARD_FORM: ProgramTemplateRewardStepV2Type = {
  referrerReward: {
    enabled: false,
    valueType: "fixed",
    value: 0,
    currency: "USD",
  },
  refereeReward: {
    enabled: false,
    valueType: "percentage",
    value: 0,
    currency: "USD",
  },
};
export function useRewardForm(
  defaultValues: ProgramTemplateRewardStepV2Type,
  submit?: (value: ProgramTemplateRewardStepV2Type) => Promise<void>,
): RewardForm {
  return useForm<
    ProgramTemplateRewardStepV2Type,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    typeof programTemplateRewardStepSchemaV2,
    undefined,
    undefined,
    undefined,
    undefined,
    unknown
  >({
    defaultValues,
    validators: { onSubmit: programTemplateRewardStepSchemaV2 },
    onSubmit: async ({ value }) => {
      await submit?.(value);
    },
  });
}
export function RewardStepForm({
  form,
  templateId,
}: {
  form: RewardForm;
  templateId: string;
}) {
  const sides = getTemplateRewardModule(templateId).formSides;
  return (
    <form.Subscribe selector={(state) => state.values}>
      {(values) => (
        <div className="space-y-4">
          <form.Field name="firstPaidOnly">
            {(field) => (
              <Label className="flex gap-3 items-center">
                <Switch
                  checked={field.state.value ?? false}
                  onCheckedChange={field.handleChange}
                />
                First paid purchase only
              </Label>
            )}
          </form.Field>
          {sides.map((side) => (
            <Card key={side}>
              <CardHeader>
                <CardTitle>
                  {side === "referrerReward"
                    ? "Referrer commission"
                    : "Buyer checkout discount"}
                </CardTitle>
                <form.Field name={`${side}.enabled`}>
                  {(field) => (
                    <Label className="flex gap-3 items-center">
                      <Switch
                        checked={field.state.value}
                        onCheckedChange={field.handleChange}
                        data-testid={
                          side === "referrerReward"
                            ? "referrer-reward-enabled"
                            : "referee-reward-enabled"
                        }
                      />
                      Enabled
                    </Label>
                  )}
                </form.Field>
              </CardHeader>
              <form.Field name={`${side}.enabled`}>
                {(enabled) =>
                  enabled.state.value && (
                    <CardContent className="space-y-4">
                      <form.Field name={`${side}.currency`}>
                        {(field) => (
                          <Label className="flex gap-3 items-center">
                            Currency
                            <select
                              value={field.state.value ?? ""}
                              onChange={(e) =>
                                field.handleChange(
                                  currencySchema.parse(e.target.value),
                                )
                              }
                              className="border rounded p-2"
                            >
                              <option value="" disabled>
                                Select currency
                              </option>
                              {RewardCurrencies.map((c) => (
                                <option key={c} value={c}>
                                  {RewardCurrencyLabels[c]}
                                </option>
                              ))}
                            </select>
                          </Label>
                        )}
                      </form.Field>
                      <form.Field name={`${side}.valueType`}>
                        {(field) => (
                          <Label className="flex gap-3 items-center">
                            Type
                            <select
                              value={field.state.value}
                              onChange={(e) =>
                                field.handleChange(
                                  e.target.value === "fixed"
                                    ? "fixed"
                                    : "percentage",
                                )
                              }
                              className="border rounded p-2"
                            >
                              <option value="fixed">Fixed amount</option>
                              <option value="percentage">Percentage</option>
                            </select>
                          </Label>
                        )}
                      </form.Field>
                      <form.Field name={`${side}.value`}>
                        {(field) => (
                          <Label className="flex gap-3 items-center">
                            Value (
                            {values[side].valueType === "percentage"
                              ? "%"
                              : RewardCurrencySymbols[
                                  values[side].currency ?? "USD"
                                ]}
                            )
                            <Input
                              type="number"
                              min="0"
                              step="0.000001"
                              value={field.state.value}
                              onChange={(e) =>
                                field.handleChange(Number(e.target.value))
                              }
                              className="w-40"
                              aria-invalid={field.state.meta.errors.length > 0}
                              aria-describedby={`${field.name}-error`}
                            />
                            {field.state.meta.errors.length > 0 && (
                              <span
                                id={`${field.name}-error`}
                                role="alert"
                                className="text-sm text-destructive"
                              >
                                {field.state.meta.errors
                                  .map((error) =>
                                    typeof error === "string"
                                      ? error
                                      : error?.message,
                                  )
                                  .join(", ")}
                              </span>
                            )}
                          </Label>
                        )}
                      </form.Field>
                      {side === "referrerReward" ? (
                        <form.Field name="referrerReward.basis">
                          {(field) => (
                            <Label className="flex gap-3 items-center">
                              Commission basis
                              <select
                                value={field.state.value ?? ""}
                                onChange={(e) =>
                                  field.handleChange(
                                    e.target.value === "base_amount"
                                      ? "base_amount"
                                      : "payable_amount",
                                  )
                                }
                                className="border rounded p-2"
                              >
                                <option value="" disabled>
                                  Select explicitly
                                </option>
                                <option value="base_amount">
                                  Before buyer discount
                                </option>
                                <option value="payable_amount">
                                  After buyer discount
                                </option>
                              </select>
                            </Label>
                          )}
                        </form.Field>
                      ) : (
                        <>
                          <form.Field name="refereeReward.minPurchaseAmount">
                            {(field) => (
                              <Label className="flex gap-3 items-center">
                                Minimum purchase (
                                {values.refereeReward.currency ??
                                  "select currency"}
                                )
                                <Input
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  value={field.state.value ?? ""}
                                  onChange={(e) =>
                                    field.handleChange(
                                      e.target.value === ""
                                        ? undefined
                                        : Number(e.target.value),
                                    )
                                  }
                                  className="w-40"
                                  aria-invalid={
                                    field.state.meta.errors.length > 0
                                  }
                                  aria-describedby={`${field.name}-error`}
                                />
                                {field.state.meta.errors.length > 0 && (
                                  <span
                                    id={`${field.name}-error`}
                                    role="alert"
                                    className="text-sm text-destructive"
                                  >
                                    {field.state.meta.errors
                                      .map((error) =>
                                        typeof error === "string"
                                          ? error
                                          : error?.message,
                                      )
                                      .join(", ")}
                                  </span>
                                )}
                              </Label>
                            )}
                          </form.Field>
                          <form.Field name="refereeReward.validityDays">
                            {(field) => (
                              <Label className="flex gap-3 items-center">
                                Validity days from program start (optional)
                                <Input
                                  type="number"
                                  min="1"
                                  step="1"
                                  value={field.state.value ?? ""}
                                  onChange={(e) =>
                                    field.handleChange(
                                      e.target.value === ""
                                        ? undefined
                                        : Number(e.target.value),
                                    )
                                  }
                                  className="w-40"
                                  aria-invalid={
                                    field.state.meta.errors.length > 0
                                  }
                                  aria-describedby={`${field.name}-error`}
                                />
                                {field.state.meta.errors.length > 0 && (
                                  <span
                                    id={`${field.name}-error`}
                                    role="alert"
                                    className="text-sm text-destructive"
                                  >
                                    {field.state.meta.errors
                                      .map((error) =>
                                        typeof error === "string"
                                          ? error
                                          : error?.message,
                                      )
                                      .join(", ")}
                                  </span>
                                )}
                              </Label>
                            )}
                          </form.Field>
                        </>
                      )}
                    </CardContent>
                  )
                }
              </form.Field>
            </Card>
          ))}
          <p className="text-sm text-muted-foreground">
            No rates, periods or minimums are pre-approved. First-payment
            tracking requires administrator approval of exact version 1 half-up
            examples, commission basis and verified recipient ownership before
            activation. Buyer discounts are applied by the checkout service, not
            issued as signup coupons.
          </p>
        </div>
      )}
    </form.Subscribe>
  );
}
