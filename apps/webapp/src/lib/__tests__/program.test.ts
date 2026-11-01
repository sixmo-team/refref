import { describe, expect, it } from "vitest";
import type { ProgramConfigV1Type } from "@refref/types";
import { defaultWidgetConfig, notificationConfigV1Schema } from "@refref/types";
import { getSetupProgress, parseConfig } from "../program";

describe("legacy program configuration", () => {
  it("retains the referral action's reward and installation completion", () => {
    const reward = { amount: -15, currency: "USD", customLegacyField: "retained" };
    const config: ProgramConfigV1Type = {
      schemaVersion: 1,
      widgetConfig: defaultWidgetConfig,
      actions: [{ actionId: "signup", reward: { amount: 2 } }, { actionId: "referral", reward }],
      notification: { installation: { completed: true } },
    };
    expect(parseConfig(config).reward).toEqual(reward);
    expect(getSetupProgress(config).steps.find((step) => step.id === "installation")?.isComplete).toBe(true);
  });

  it("does not mark absent or malformed installation data complete", () => {
    for (const notification of [undefined, {}, { installation: null }, { installation: "pending" }, { installation: { completed: false } }, { installation: { completed: "pending" } }]) {
      const config: ProgramConfigV1Type = { schemaVersion: 1, widgetConfig: defaultWidgetConfig, notification };
      expect(getSetupProgress(config).steps.find((step) => step.id === "installation")?.isComplete).toBe(false);
    }
    expect(parseConfig(null)).toEqual({ notification: null, reward: null, version: 1 });
  });

  it("retains notification settings and legacy setup metadata while rejecting invalid known fields", () => {
    const notification = {
      welcomeEmail: { enabled: true, subject: "Welcome", template: "Hello {name}" },
      successEmail: { enabled: false, subject: "Reward approved", template: "Approved" },
      inApp: { progressUpdates: true, rewardNotifications: false },
      installation: { completed: true },
      customLegacySetting: "retained",
    };
    expect(notificationConfigV1Schema.parse(notification)).toEqual(notification);
    expect(notificationConfigV1Schema.safeParse({
      welcomeEmail: { enabled: "yes", subject: "Welcome", template: "Hello" },
    }).success).toBe(false);
    expect(notificationConfigV1Schema.parse({})).toEqual({});
  });
});
