import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  minorPurchaseRequestSchema,
  type MinorPurchaseResponse,
} from "@refref/types";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { RefRefAPIClient } from "./api-client";

const sensitive = "transport-person+private@example.test";

describe("SDK HTTP trust boundary", () => {
  it.each([
    "",
    "file:///tmp/refref",
    "https://name:password@api.example.test",
    "https://api.example.test/?token=private",
    "https://api.example.test/#private",
  ])("rejects an unsafe API base URL: %s", (url) => {
    expect(() => new RefRefAPIClient("regression-key", url)).toThrow();
  });

  it.each([
    {
      title: "valid JSON",
      status: 200,
      body: { eventId: "event-sdk-test", email: sensitive },
      success: true,
    },
    {
      title: "invalid response shape",
      status: 200,
      body: { eventId: 42, email: sensitive },
      success: false,
    },
    {
      title: "HTTP error",
      status: 500,
      body: { error: sensitive },
      success: false,
    },
  ])(
    "handles $title without retaining or logging response PII",
    async ({ status, body, success }) => {
      const diagnostics: unknown[][] = [];
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          diagnostics.push(args);
        });
      const server = createServer((request, response) => {
        request.resume();
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No TCP test listener");
        const client = new RefRefAPIClient(
          "regression-key",
          `http://127.0.0.1:${address.port}`,
        );
        const result = await client.trackSignup({
          timestamp: "2026-10-19T00:00:00Z",
          productId: "regression-product",
          payload: { userId: "regression-user" },
        });
        expect(result.success).toBe(success);
        if (success) expect(result.data).toEqual({ eventId: "event-sdk-test" });
        expect(inspect({ result, diagnostics })).not.toContain(sensitive);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        consoleError.mockRestore();
      }
    },
  );
  it.each(["chunked oversized body", "redirect"] as const)(
    "rejects %s without retaining response content",
    async (mode) => {
      const server = createServer((request, response) => {
        request.resume();
        if (mode === "redirect") {
          response.writeHead(302, {
            location: "http://127.0.0.1:1/must-not-follow",
          });
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('"' + sensitive + "x".repeat(256 * 1024));
          response.end('"');
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No listener");
        const result = await new RefRefAPIClient(
          "test-key",
          `http://127.0.0.1:${address.port}`,
        ).trackSignup({
          timestamp: new Date().toISOString(),
          productId: "sdk-product",
          payload: { userId: "sdk-user" },
        });
        expect(result.success).toBe(false);
        expect(inspect(result)).not.toContain(sensitive);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it("matches reward ACKs to expected rules, including an explicitly disabled commission", async () => {
    const productId = randomUUID(),
      programId = randomUUID(),
      buyerId = randomUUID(),
      referrerId = randomUUID();
    const rules = [1, 2].map((priority) => ({
      ruleId: randomUUID(),
      priority,
      config: {
        schemaVersion: 1,
        trigger: { event: "purchase" },
        participantType: "referrer",
        conditions: { firstPaidOnly: true },
        reward: { type: "cash", amount: 1, unit: "fixed", currency: "RUB" },
      },
    }));
    const confirmedAt = new Date().toISOString();
    const payload = minorPurchaseRequestSchema.parse({
      timestamp: confirmedAt,
      productId,
      programId,
      payload: {
        userId: buyerId,
        orderId: randomUUID(),
        orderAmountMinor: 100,
        currency: "RUB",
        customer: { name: "SDK buyer", email: `${buyerId}@example.test` },
        referralSnapshot: {
          schemaVersion: 1,
          calculationVersion: 1,
          acceptedAt: confirmedAt,
          offerVersion: "a".repeat(64),
          firstPaidOnly: true,
          attribution: {
            productId,
            programId,
            codeId: randomUUID(),
            codeValue: "abc1234",
            referrerParticipantId: referrerId,
          },
          pricing: {
            planCode: "sdk",
            priceVersion: "v1",
            currency: "RUB",
            baseAmountMinor: 101,
            discountAmountMinor: 1,
            payableAmountMinor: 100,
            buyerDiscountApplicable: true,
            buyerDiscountReason: null,
          },
          buyerDiscount: {
            kind: "fixed",
            amountMinor: 1,
            minPurchaseAmountMinor: null,
          },
          commission: { basis: "payable_amount", rules },
        },
      },
    });
    const rewardIds = [randomUUID(), randomUUID()];
    const ack: MinorPurchaseResponse = {
      success: true,
      message: "Purchase recorded",
      eventId: randomUUID(),
      productId,
      programId,
      orderId: payload.payload.orderId,
      codeId: payload.payload.referralSnapshot.attribution.codeId,
      customerExternalId: buyerId,
      participantId: randomUUID(),
      referralId: randomUUID(),
      referrerParticipantId: referrerId,
      rewardIds,
      duplicate: false,
      rewards: payload.payload.referralSnapshot.commission.rules.map(
        (rule) => ({
          id: rewardIds[0]!,
          ruleId: rule.ruleId,
          participantId: referrerId,
          type: "cash",
          amountMinor: 100,
          currency: "RUB",
          config: rule.config,
        }),
      ),
    };
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ack));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No TCP test listener");
      const client = new RefRefAPIClient(
        "test-key",
        `http://127.0.0.1:${address.port}`,
      );
      expect((await client.trackPurchase(payload)).success).toBe(false);
      ack.rewards[1]!.id = rewardIds[1]!;
      expect(await client.trackPurchase(payload)).toMatchObject({
        success: true,
        data: { rewardIds },
      });
      ack.rewardIds = [];
      ack.rewards = [];
      expect((await client.trackPurchase(payload)).success).toBe(false);
      const buyerOnly = minorPurchaseRequestSchema.parse({
        ...payload,
        payload: {
          ...payload.payload,
          userId: randomUUID(),
          orderId: randomUUID(),
          referralSnapshot: {
            ...payload.payload.referralSnapshot,
            commission: { basis: null, rules: [] },
          },
        },
      });
      ack.orderId = buyerOnly.payload.orderId;
      ack.customerExternalId = buyerOnly.payload.userId;
      expect(await client.trackPurchase(buyerOnly)).toMatchObject({
        success: true,
        data: { rewardIds: [], rewards: [] },
      });
      expect(requests).toBe(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("propagates caller cancellation to one real resolve request", async () => {
    const controller = new AbortController();
    let requests = 0;
    const resolution = {
      codeId: randomUUID(),
      canonicalCode: "abc1234",
      productId: randomUUID(),
      programId: randomUUID(),
      referrerParticipantId: randomUUID(),
      firstPaidOnly: true,
      currency: "RUB",
      calculationVersion: 1,
      buyerDiscount: { kind: "none" },
      commission: {
        basis: "payable_amount",
        rules: [
          {
            ruleId: randomUUID(),
            priority: 1,
            config: {
              schemaVersion: 1,
              trigger: { event: "purchase" },
              participantType: "referrer",
              conditions: { firstPaidOnly: true },
              reward: {
                type: "cash",
                amount: 1,
                unit: "fixed",
                currency: "RUB",
              },
            },
          },
        ],
      },
    };
    const server = createServer((request, response) => {
      requests++;
      expect(request.url).toBe("/v1/referrals/resolve");
      request.resume();
      controller.abort();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(resolution));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No listener");
      const result = await new RefRefAPIClient(
        "test-key",
        `http://127.0.0.1:${address.port}`,
      ).resolveReferral(
        {
          productId: resolution.productId,
          programId: resolution.programId,
          customerExternalId: randomUUID(),
          code: "abc1234",
        },
        { signal: controller.signal },
      );
      expect(result.success).toBe(false);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("bounds a stalled real response by the SDK deadline", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No listener");
      const started = Date.now();
      const result = await new RefRefAPIClient(
        "test-key",
        `http://127.0.0.1:${address.port}`,
      ).trackSignup({
        timestamp: new Date().toISOString(),
        productId: randomUUID(),
        payload: { userId: randomUUID() },
      });
      expect(result.success).toBe(false);
      expect(Date.now() - started).toBeLessThan(6500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 7000);
});
