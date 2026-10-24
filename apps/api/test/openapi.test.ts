import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "playwright";
import { startTestServer, stopTestServer } from "./utils/testServer.js";
import type { APIRequestContext } from "playwright";

describe("OpenAPI Endpoint", () => {
  let apiContext: APIRequestContext;
  let baseURL: string;

  beforeAll(async () => {
    // Start test server
    const { url } = await startTestServer();
    baseURL = url;

    // Create Playwright API request context
    apiContext = await request.newContext({
      baseURL,
    });
  });

  afterAll(async () => {
    // Clean up
    await apiContext.dispose();
    await stopTestServer();
  });

  describe("GET /openapi", () => {
    it("should return OpenAPI spec as YAML", async () => {
      const response = await apiContext.get("/openapi");

      expect(response.ok()).toBe(true);
      expect(response.status()).toBe(200);

      const contentType = response.headers()["content-type"];
      expect(contentType).toContain("text/yaml");
    });
  });
});
