import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "playwright";
import { startTestServer, stopTestServer } from "./utils/testServer.js";
import type { APIRequestContext } from "playwright";

describe("Track API", () => {
  let apiContext: APIRequestContext;
  let baseURL: string;

  beforeAll(async () => {
    const { url } = await startTestServer();
    baseURL = url;

    apiContext = await request.newContext({
      baseURL,
    });
  });

  afterAll(async () => {
    await apiContext.dispose();
    await stopTestServer();
  });

  describe.each([
    "/v1/track/signup",
    "/v1/track/purchase",
    "/v1/referrals/resolve",
  ])("%s authentication precedence", (path) => {
    it("should return 401 when authentication fails before request validation", async () => {
      const response = await apiContext.post(path, {
        headers: {
          "x-api-key": "invalid-key",
          "content-type": "application/json",
        },
        data: "invalid json {{{",
      });

      expect(response.status()).toBe(401);
    });

    it("should return 401 for invalid schema with bad API key", async () => {
      // Auth happens first, so bad API key returns 401
      const response = await apiContext.post(path, {
        headers: {
          "x-api-key": "invalid-key",
        },
        data: {
          // Missing required fields
        },
      });

      expect(response.status()).toBe(401);
    });
  });

  describe("POST /v1/track/signup - Signup Events", () => {
    it("should require API key authentication", async () => {
      const response = await apiContext.post("/v1/track/signup", {
        data: {
          timestamp: new Date().toISOString(),
          productId: "test-product",
          payload: {
            userId: "user_123",
            email: "test@example.com",
          },
        },
      });

      expect(response.status()).toBe(401);
    });
  });
});
