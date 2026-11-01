// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultConfig } from "./config";
// Each test reloads the module because installation consumes the host's preload queue.

beforeEach(() => {
  vi.resetModules();
  window.RefRef = [];
  window.history.replaceState(null, "", "/");
  document.cookie = "refref-refcode=; Max-Age=-1; Path=/";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retains preload commands, late push commands, direct methods and the live open property", async () => {
  window.RefRef.push(["setConfig", { title: "Queued title" }]);
  window.RefRef.push(["open"]);
  const { initRefRef } = await import("./refref");
  const client = window.RefRef;
  if (Array.isArray(client)) throw new Error("Widget API was not installed");
  client.push(["toggle"]);
  const api = initRefRef();
  expect(api.getConfig().title).toBe("Queued title");
  expect(client.isOpen).toBe(false);
  client.open();
  expect(client.isOpen).toBe(true);
  client.push(["close"]);
  expect(client.isOpen).toBe(false);
  client.setConfig({ title: "Direct title" });
  expect(client.getConfig().title).toBe("Direct title");
});

it("keeps authenticated initialization and fresh query attribution ahead of stored cookies", async () => {
  window.history.replaceState(null, "", "/?refcode=fresh-code");
  document.cookie = "refref-refcode=stored-code; Path=/";
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify({ ...defaultConfig, title: "Loaded title" })),
  );
  vi.stubGlobal("fetch", fetch);
  const { initRefRef } = await import("./refref");
  const api = initRefRef();
  await api.init({
    productId: "widget-product",
    participantId: "local-user",
    token: "signed-token",
    apiUrl: "https://api.example.test",
  });
  expect(fetch).toHaveBeenCalledWith("https://api.example.test/v1/widget/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer signed-token",
    },
    body: JSON.stringify({ productId: "widget-product", refcode: "fresh-code" }),
  });
  expect(api.getConfig().title).toBe("Loaded title");
  const { widgetStore } = await import("./store");
  expect(widgetStore.getState()).toMatchObject({
    initialized: true,
    participantId: "local-user",
    productId: "widget-product",
    token: "signed-token",
  });
});

it("rejects incomplete success data without publishing a new participant or replacing valid configuration", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify({ title: "Incomplete response" })),
  ));
  const { initRefRef } = await import("./refref");
  const api = initRefRef();
  const config = api.getConfig();
  await expect(api.init({
    productId: "unaccepted-product",
    participantId: "unaccepted-participant",
    token: "unaccepted-token",
    apiUrl: "https://api.example.test",
  })).rejects.toBeInstanceOf(Error);
  const { widgetStore } = await import("./store");
  expect(widgetStore.getState()).toMatchObject({
    initialized: false,
    participantId: "",
    productId: undefined,
    token: undefined,
    config,
  });
});
