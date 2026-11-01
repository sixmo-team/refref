import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;

export default defineConfig({
  esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react/jsx-dev-runtime"] },
  resolve: {
    alias: { "@refref/ui": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.browser.test.tsx"],
    maxWorkers: 1,
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(wsEndpoint ? { connectOptions: { wsEndpoint } } : {}),
      instances: [{ browser: "chromium" }],
    },
  },
});
