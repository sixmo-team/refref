// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartnerProgramSettings } from "./partner-program-settings";

const state = vi.hoisted(() => ({
  userId: "editor",
  organizationId: "organization",
  refetching: false,
  readFailure: false,
}));
const savedBody = "Сохранённый текст правил программы. ".repeat(10);
vi.mock("@/lib/auth-client", () => ({
  useActiveMember: () => ({
    data: {
      userId: state.userId,
      organizationId: state.organizationId,
      role: "owner",
    },
    isPending: false,
    isRefetching: state.refetching,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({ program: { partnerRules: { reset: vi.fn() } } }),
    program: {
      partnerRules: {
        useQuery: () => ({
          data: {
            enabled: false,
            economics: null,
            termsFingerprint: null,
            rules: {
              id: "rules",
              body: savedBody,
              publishedAt: new Date("2026-10-31T00:00:00Z"),
            },
          },
          error: null,
          failureReason: null,
          isError: state.readFailure,
          isFetching: false,
          isSuccess: !state.readFailure,
          isPlaceholderData: false,
          dataUpdatedAt: 1,
        }),
      },
      publishPartnerRules: { useMutation: () => ({ isPending: false }) },
      setPartnerSelfService: { useMutation: () => ({ isPending: false }) },
    },
  },
}));
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
async function render(programId = "program") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PartnerProgramSettings
          program={{ id: programId, productId: "product", status: "active" }}
          scope={{ userId: state.userId, organizationId: state.organizationId }}
        />
      </QueryClientProvider>,
    ),
  );
}
function editor() {
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("Missing legal rules editor");
  return textarea;
}
async function edit(body: string) {
  await act(async () => {
    const textarea = editor();
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, body);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(state, {
    userId: "editor",
    organizationId: "organization",
    refetching: false,
    readFailure: false,
  });
  host = document.createElement("div");
  // JSDOM has no layout observer; keep the actual React/Radix form controls.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
});
it("keeps an unpublished draft across authorization revalidation and transient read failures, without showing it during either", async () => {
  await render();
  const draft = "Неопубликованная редакция администратора. ".repeat(10);
  await edit(draft);
  expect(editor().value).toBe(draft);
  state.refetching = true;
  await render();
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.textContent).not.toContain(draft);
  state.refetching = false;
  await render();
  expect(editor().value).toBe(draft);
  state.readFailure = true;
  await render();
  expect(host.querySelector("textarea")).toBeNull();
  state.readFailure = false;
  await render();
  expect(editor().value).toBe(draft);
});
it("discards private drafts when the programme, organization or user changes", async () => {
  await render();
  await edit("Черновик другой программы");
  await render("other-program");
  expect(editor().value).toBe(savedBody);
  await edit("Черновик другой организации");
  state.organizationId = "other-organization";
  await render("other-program");
  expect(editor().value).toBe(savedBody);
  await edit("Черновик другого пользователя");
  state.userId = "other-editor";
  await render("other-program");
  expect(editor().value).toBe(savedBody);
});
