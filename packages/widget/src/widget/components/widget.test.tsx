// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { widgetStore } from "../../lib/store";
import { defaultConfig } from "../../lib/config";
import { Widget } from "./widget";
import { WidgetContainer } from "./widget-container";

const roots = new Set<Root>();
const originalState = { ...widgetStore.getState() };

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  return { host, root };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  widgetStore.setState({ ...originalState }, true);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.replaceChildren();
  widgetStore.setState(originalState, true);
  vi.restoreAllMocks();
});

it("accepts asynchronous configuration and preserves native close/reopen in the surviving instance's portal", async () => {
  Object.assign(widgetStore.getState(), { config: null });
  const first = mount();
  await act(async () => first.root.render(<Widget />));
  expect(first.host.childElementCount).toBe(0);
  await act(async () => {
    widgetStore.setState({ config: defaultConfig, isOpen: true });
  });
  const firstPortal = first.host.querySelector<HTMLDivElement>("#widget-portal-container");
  expect(firstPortal).toBeInstanceOf(HTMLDivElement);
  expect(firstPortal?.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => firstPortal?.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click());
  expect(widgetStore.getState().isOpen).toBe(false);

  // Both instances share the existing store; native non-modal dialogs dismiss
  // each other on outside focus, so keep them closed during the sibling mount.
  const second = mount();
  await act(async () => second.root.render(<Widget />));
  const secondPortal = second.host.querySelector<HTMLDivElement>("#widget-portal-container");
  expect(secondPortal).toBeInstanceOf(HTMLDivElement);
  expect(firstPortal).not.toBe(secondPortal);
  await act(async () => first.root.unmount());
  roots.delete(first.root);
  expect(first.host.childElementCount).toBe(0);
  await act(async () => second.host.querySelector<HTMLButtonElement>('[aria-label="Open referral widget"]')?.click());
  expect(secondPortal?.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(widgetStore.getState().isOpen).toBe(false);
  await act(async () => second.host.querySelector<HTMLButtonElement>('[aria-label="Open referral widget"]')?.click());
  expect(secondPortal?.querySelector('[role="dialog"]')).not.toBeNull();
});

it("registers dynamic triggers once, releases detached nodes and reattaches without toggling an open widget closed", async () => {
  const mounted = mount();
  let opens = 0;
  widgetStore.setState({
    initialized: true,
    widgetElementSelector: "[data-widget-test]",
    setIsOpen: (isOpen) => {
      opens += 1;
      widgetStore.setState({ isOpen });
    },
  });
  await act(async () => mounted.root.render(<WidgetContainer />));
  const trigger = document.createElement("button");
  trigger.dataset.widgetTest = "";
  await act(async () => document.body.append(trigger));
  await act(async () => document.body.append(document.createElement("span")));
  await act(async () => trigger.click());
  expect(opens).toBe(1);
  expect(widgetStore.getState().isOpen).toBe(true);
  await act(async () => trigger.click());
  expect(opens).toBe(2);
  expect(widgetStore.getState().isOpen).toBe(true);
  await act(async () => trigger.remove());
  await act(async () => widgetStore.setState({ isOpen: false }));
  await act(async () => trigger.click());
  expect(opens).toBe(2);
  expect(widgetStore.getState().isOpen).toBe(false);
  await act(async () => document.body.append(trigger));
  await act(async () => trigger.click());
  expect(opens).toBe(3);
  expect(widgetStore.getState().isOpen).toBe(true);
  await act(async () => mounted.root.unmount());
  roots.delete(mounted.root);
  trigger.click();
  expect(opens).toBe(3);
});

it("preserves social browser sharing, Instagram text copying and the referral-link clipboard action", async () => {
  const mounted = mount();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  try {
    widgetStore.setState({
      isOpen: true,
      config: {
        ...defaultConfig,
        enabledPlatforms: { ...defaultConfig.enabledPlatforms, instagram: true },
      },
    });
    await act(async () => mounted.root.render(<Widget />));
    const twitter = mounted.host.querySelector<HTMLButtonElement>('[aria-label="Share on X"]');
    const instagram = mounted.host.querySelector<HTMLButtonElement>('[aria-label="Share on Instagram"]');
    const copy = mounted.host.querySelector<HTMLButtonElement>('[aria-label="Copy referral link to clipboard"]');
    expect(twitter).toBeInstanceOf(HTMLButtonElement);
    expect(instagram).toBeInstanceOf(HTMLButtonElement);
    expect(copy).toBeInstanceOf(HTMLButtonElement);
    const message = defaultConfig.shareMessage.replace("{productName}", defaultConfig.productName);
    await act(async () => twitter?.click());
    expect(open).toHaveBeenCalledWith(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${encodeURIComponent(defaultConfig.referralLink)}`,
      "_blank",
      "width=600,height=400",
    );
    await act(async () => instagram?.click());
    expect(writeText).toHaveBeenLastCalledWith(`${message} ${defaultConfig.referralLink}`);
    expect(alert).toHaveBeenCalledWith("Link copied! You can now paste it in your Instagram story or post.");
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenLastCalledWith(defaultConfig.referralLink);
    expect(mounted.host.querySelector('[aria-label="Copied to clipboard"]')).not.toBeNull();
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
