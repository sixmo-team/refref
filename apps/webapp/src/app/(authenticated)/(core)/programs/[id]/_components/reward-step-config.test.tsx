// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RewardStepConfig } from "./reward-step-config";

const state = vi.hoisted(() => ({
  scope: { userId: "", organizationId: "" },
  program: {
    id: "",
    productId: "",
    programTemplateId: "double-sided",
    status: "pending_approval",
    termsFingerprint: "a".repeat(64),
    startDate: null as Date | null,
    endDate: null as Date | null,
    config: {
      rewardConfig: {
        firstPaidOnly: true,
        referrer: {
          type: "cash",
          valueType: "fixed",
          value: 1,
          currency: "RUB",
          basis: "payable_amount",
        },
      },
    },
  },
  rules: [],
}));
vi.mock("@/lib/auth-client", () => ({
  useActiveMember: () => ({
    data: { ...state.scope, role: "owner" },
    isPending: false,
    isRefetching: false,
    error: null,
  }),
}));
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({
      program: {
        getById: { invalidate: vi.fn() },
        getAll: { invalidate: vi.fn() },
      },
      rewardRules: { getByProgram: { invalidate: vi.fn() } },
    }),
    program: {
      getById: {
        useQuery: () => ({ data: state.program, error: null }),
      },
      saveTemplateConfiguration: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      approveServerTracking: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
    },
    rewardRules: {
      getByProgram: {
        useQuery: () => ({ data: state.rules, error: null }),
      },
    },
  },
}));
let host: HTMLDivElement;
let root: Root;
async function render() {
  await act(async () =>
    root.render(
      <RewardStepConfig programId={state.program.id} scope={state.scope} />,
    ),
  );
}
function controls() {
  const checkbox = host.querySelector<HTMLInputElement>(
    'section input[type="checkbox"]',
  );
  const button = Array.from(host.querySelectorAll("button")).find((element) =>
    element.textContent?.includes("Record explicit approval and activate"),
  );
  if (!checkbox || !button)
    throw new Error("Missing financial review controls");
  return { checkbox, button };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.scope = { userId: randomUUID(), organizationId: randomUUID() };
  state.program = {
    ...state.program,
    id: randomUUID(),
    productId: randomUUID(),
    termsFingerprint: "a".repeat(64),
    startDate: null,
    endDate: null,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it.each([
  "saved terms",
  "start date",
  "end date",
  "saved start date",
  "saved end date",
] as const)(
  "requires fresh acknowledgement after changing the %s",
  async (change) => {
    await render();
    expect(controls().button.disabled).toBe(true);
    await act(async () => controls().checkbox.click());
    expect(controls().button.disabled).toBe(false);
    if (change === "saved terms") {
      state.program = { ...state.program, termsFingerprint: "b".repeat(64) };
      await render();
    } else if (change === "saved start date" || change === "saved end date") {
      state.program = {
        ...state.program,
        [change === "saved start date" ? "startDate" : "endDate"]: new Date(
          "2099-01-01T12:00:00.000Z",
        ),
      };
      await render();
    } else {
      await act(async () => {
        const dates = host.querySelectorAll<HTMLInputElement>(
          'input[type="datetime-local"]',
        );
        const input = dates.item(change === "start date" ? 0 : 1);
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "2099-01-01T12:00");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    expect(controls().checkbox.checked).toBe(false);
    expect(controls().button.disabled).toBe(true);
    await act(async () => controls().checkbox.click());
    expect(controls().button.disabled).toBe(false);
  },
);
