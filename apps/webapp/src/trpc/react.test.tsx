// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useQuery,
  useSuspenseQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, TRPCReactProvider } from "./react";

const authState = vi.hoisted(() => ({
  userId: null as string | null,
  organizationId: "",
  isPending: false,
  isRefetching: false,
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: authState.userId
      ? {
          user: { id: authState.userId },
          session: { activeOrganizationId: authState.organizationId },
        }
      : null,
    error: null,
    isPending: authState.isPending,
    isRefetching: authState.isRefetching,
    refetch: async () => undefined,
  }),
}));

const rowsKey = getQueryKey(
  api.participants.getAll,
  { page: 1, pageSize: 10 },
  "query",
);
let host: HTMLDivElement;
let root: Root;
let currentClient: QueryClient;
let renders: Array<{
  userId: string | null;
  organizationId: string;
  rows: string | undefined;
}>;
let firstPerson: string;
let firstOrganization: string;
const clients = new Set<QueryClient>();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function PrivateRows() {
  currentClient = useQueryClient();
  clients.add(currentClient);
  const rows = useQuery<string>({
    queryKey: rowsKey,
    queryFn: async () => "unexpected fetch",
    enabled: false,
  });
  renders.push({
    userId: authState.userId,
    organizationId: authState.organizationId,
    rows: rows.data,
  });
  return (
    <>
      <p>{rows.data ?? "No private rows"}</p>
      <input aria-label="Unsaved draft" defaultValue="" />
    </>
  );
}
async function render() {
  await act(async () => {
    root.render(
      <TRPCReactProvider>
        <PrivateRows />
      </TRPCReactProvider>,
    );
    await tick();
  });
}
async function seedRows(value: string) {
  await act(async () => {
    currentClient.setQueryData(rowsKey, value);
    await tick();
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  renders = [];
  host = document.createElement("div");
  document.body.append(host);
  firstPerson = randomUUID();
  firstOrganization = randomUUID();
  Object.assign(authState, {
    userId: firstPerson,
    organizationId: firstOrganization,
    isPending: false,
    isRefetching: false,
  });
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const client of clients) client.clear();
  clients.clear();
  host.remove();
});

describe("session-owned tRPC query cache", () => {
  it("does not render the previous organization's PII, including a late old response", async () => {
    await render();
    await seedRows("organization-a-private@example.test");
    const original = currentClient;
    let complete!: (value: string) => void;
    const pending = original.fetchQuery({
      queryKey: rowsKey,
      queryFn: () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
      staleTime: 0,
    });
    void pending.catch(() => undefined);
    const nextOrganization = randomUUID();
    authState.organizationId = nextOrganization;
    await render();
    expect(host.textContent).toContain("No private rows");
    expect(
      renders
        .filter((value) => value.organizationId === nextOrganization)
        .every((value) => value.rows === undefined),
    ).toBe(true);
    await act(async () => {
      complete("late-organization-a-private@example.test");
      await pending;
      await tick();
    });
    expect(currentClient.getQueryData(rowsKey)).toBeUndefined();
    expect(
      renders
        .filter((value) => value.organizationId === nextOrganization)
        .every((value) => value.rows === undefined),
    ).toBe(true);
  });

  it("discards cached rows on logout and same-tab login, even for the same person and organization", async () => {
    await render();
    await seedRows("previous-session-private@example.test");
    authState.userId = null;
    await render();
    expect(host.textContent).toContain("No private rows");
    authState.userId = firstPerson;
    await render();
    expect(host.textContent).toContain("No private rows");
    const nextPerson = randomUUID();
    authState.userId = nextPerson;
    await render();
    expect(
      renders
        .filter((value) => value.userId === nextPerson)
        .every((value) => value.rows === undefined),
    ).toBe(true);
  });
  it("preserves dirty forms and cached rows while the same session is refetching", async () => {
    await render();
    await seedRows("same-owner-private@example.test");
    const input = host.querySelector("input")!;
    input.value = "Unsaved reward configuration";
    authState.isPending = true;
    authState.isRefetching = true;
    await render();
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsaved reward configuration");
    expect(host.textContent).toContain("same-owner-private@example.test");
    authState.isPending = false;
    authState.isRefetching = false;
    await render();
    expect(host.querySelector("input")).toBe(input);
  });

  it("completes one initial suspense query without a lower Suspense boundary or a reload loop", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const queryKey = ["initial-suspense", randomUUID()];
    let loads = 0;
    function SuspendingRows() {
      clients.add(useQueryClient());
      const { data } = useSuspenseQuery({
        queryKey,
        queryFn: () => {
          loads++;
          return pending;
        },
        retry: false,
      });
      return <p>{data}</p>;
    }
    await act(async () => {
      root.render(
        <TRPCReactProvider>
          <SuspendingRows />
        </TRPCReactProvider>,
      );
      await tick();
    });
    await act(async () => {
      release("Loaded referral data");
      await pending;
      await tick();
    });
    expect(host.textContent).toContain("Loaded referral data");
    expect(loads).toBe(1);
  });
});
