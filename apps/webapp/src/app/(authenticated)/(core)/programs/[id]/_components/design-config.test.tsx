// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultWidgetConfig, type ProgramConfigV1Type } from "@refref/types";
import { DesignConfig } from "./design-config";

const state = vi.hoisted(() => ({ config: undefined as ProgramConfigV1Type | undefined }));
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({ program: { getById: { invalidate: vi.fn() }, getAll: { invalidate: vi.fn() } } }),
    program: {
      getById: { useQuery: () => ({ data: { config: state.config }, error: null, isError: false }) },
      updateConfig: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));
// Isolate browser-only preview rendering; exercise the real design controls/state.
vi.mock("@/components/preview-pane", () => ({ PreviewPane: () => null }));
vi.mock("@/components/widget-preview", () => ({ WidgetPreview: ({ children }: { children: ReactNode }) => children }));

let host: HTMLDivElement;
let root: Root;
const scope = { userId: "designer", organizationId: "organization" };
async function render() {
  await act(async () => root.render(<DesignConfig programId="program" scope={scope} />));
}
function input(id: string) {
  const element = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`Missing input ${id}`);
  return element;
}
async function edit(id: string, value: string) {
  await act(async () => {
    const element = input(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { vi.advanceTimersByTime(301); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  state.config = {
    schemaVersion: 1,
    widgetConfig: { ...defaultWidgetConfig, title: "Saved custom title", cssVariables: { "--primary": "#123456", "--secondary": "#654321" } },
    brandConfig: { primaryColor: "#123456", landingPageUrl: "https://custom.example/landing" },
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("keeps custom color, content and landing-page edits until discard", async () => {
  await render();
  expect(input("color-primary").value).toBe("#123456");
  await edit("title", "Unsaved custom title");
  await edit("landingPageUrl", "https://edited.example/landing");
  await edit("color-primary", "#abcdef");
  expect(input("color-primary").value).toBe("#abcdef");
  expect(input("title").value).toBe("Unsaved custom title");
  expect(input("landingPageUrl").value).toBe("https://edited.example/landing");
  const discard = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Discard"));
  if (!discard) throw new Error("Missing discard action");
  await act(async () => discard.click());
  expect(input("color-primary").value).toBe("#123456");
  expect(input("title").value).toBe("Saved custom title");
  expect(input("landingPageUrl").value).toBe("https://custom.example/landing");
});

it("hydrates a selected configuration against defaults instead of prior custom colors", async () => {
  await render();
  state.config = { schemaVersion: 1, widgetConfig: { ...defaultWidgetConfig, cssVariables: { "--primary": "#fedcba" } } };
  await render();
  expect(input("color-primary").value).toBe("#fedcba");
  expect(input("color-secondary").value).toBe("#5a5370");
  expect(input("landingPageUrl").value).toBe("");
  state.config = { schemaVersion: 1, widgetConfig: defaultWidgetConfig };
  await render();
  expect(input("color-primary").value).toBe("#a995c9");
  expect(input("color-secondary").value).toBe("#5a5370");
});
