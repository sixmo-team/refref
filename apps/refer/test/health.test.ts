import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "playwright";
import { startTestServer, stopTestServer } from "./utils/testServer.js";
import type { APIRequestContext } from "playwright";

describe("Health Endpoints", () => {
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

  describe("GET /health", () => {
    it("should return status ok with service name", async () => {
      const response = await apiContext.get("/health");

      expect(response.ok()).toBe(true);
      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toMatchObject({
        status: "ok",
        service: "refer",
      });
    });

    it("should have correct content-type header", async () => {
      const response = await apiContext.get("/health");

      const contentType = response.headers()["content-type"];
      expect(contentType).toContain("application/json");
    });
  });

  describe("GET /", () => {
    it("should identify the redirect service at the root endpoint", async () => {
      const response = await apiContext.get("/");

      expect(response.ok()).toBe(true);
      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toMatchObject({
        status: "ok",
        service: "refer",
      });
    });

    it("should have correct content-type header", async () => {
      const response = await apiContext.get("/");

      const contentType = response.headers()["content-type"];
      expect(contentType).toContain("application/json");
    });
  });
});
