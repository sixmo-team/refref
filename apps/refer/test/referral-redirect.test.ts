import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createDb, schema } from "@refref/coredb";
import type { DBType } from "@refref/coredb";
import { defaultWidgetConfig } from "@refref/types";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

// Redirect authorization must exercise real SQL, not a canned query response.
vi.unmock("@refref/coredb");

describe("Referral redirect privacy", () => {
  let app: FastifyInstance | undefined;
  let db: DBType | undefined;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const suffix = randomUUID();
  const products = [
    { id: `redirect-product-a-${suffix}`, slug: `redirect-a-${suffix}` },
    { id: `redirect-product-b-${suffix}`, slug: `redirect-b-${suffix}` },
  ];
  const codes = [`a${suffix}`, `b${suffix}`];
  const participantIds = [
    `redirect-person-a-${suffix}`,
    `redirect-person-b-${suffix}`,
  ];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test")) {
      throw new Error("TEST_DATABASE_URL must name an isolated test database");
    }
    process.env.DATABASE_URL = databaseUrl;
    db = createDb(databaseUrl);
    await db.insert(schema.product).values(
      products.map((product) => ({
        ...product,
        name: "Redirect privacy test",
      })),
    );
    for (const [index, product] of products.entries()) {
      const programId = `redirect-program-${index}-${suffix}`;
      await db.insert(schema.program).values({
        id: programId,
        productId: product.id,
        programTemplateId: "refer-and-earn",
        name: "Redirect privacy test",
        status: "active",
        config: {
          schemaVersion: 1,
          brandConfig: {
            primaryColor: "#123456",
            landingPageUrl:
              index === 0
                ? "https://shop.example/offer?campaign=summer&tag=one&tag=two&refcode=stale#checkout"
                : "https://other.example/join?campaign=winter#signup",
          },
          widgetConfig: defaultWidgetConfig,
        },
      });
      await db.insert(schema.participant).values({
        id: participantIds[index]!,
        productId: product.id,
        name: "John O'Brien & Co.",
        email: `john+${index}@example.com`,
      });
      const refcodeId = `redirect-refcode-${index}-${suffix}`;
      await db.insert(schema.refcode).values({
        id: refcodeId,
        code: codes[index]!,
        participantId: participantIds[index]!,
        programId,
        productId: product.id,
      });
      await db.insert(schema.reflink).values({
        id: `redirect-reflink-${index}-${suffix}`,
        slug: "shared-vanity",
        refcodeId,
        productId: product.id,
      });
    }
    app = await buildApp();
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (db) {
        const productIds = products.map(({ id }) => id);
        await db.transaction(async (tx) => {
          await tx
            .delete(schema.reflink)
            .where(inArray(schema.reflink.productId, productIds));
          await tx
            .delete(schema.refcode)
            .where(inArray(schema.refcode.productId, productIds));
          await tx
            .delete(schema.program)
            .where(inArray(schema.program.productId, productIds));
          await tx
            .delete(schema.participant)
            .where(inArray(schema.participant.productId, productIds));
          await tx
            .delete(schema.product)
            .where(inArray(schema.product.id, productIds));
        });
      }
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await db?.$client.end();
    }
  });

  it("exposes only opaque attribution while preserving query values and fragment", async () => {
    const response = await app!.inject({
      method: "GET",
      url: `/${codes[0]!.toUpperCase()}`,
    });

    expect(response.statusCode).toBe(307);
    const location = new URL(response.headers.location!);
    expect(location.origin).toBe("https://shop.example");
    expect(location.pathname).toBe("/offer");
    expect([...location.searchParams.entries()]).toEqual([
      ["campaign", "summer"],
      ["tag", "one"],
      ["tag", "two"],
      ["refcode", codes[0]],
    ]);
    expect(location.hash).toBe("#checkout");
    for (const value of [
      "John O'Brien & Co.",
      "john+0@example.com",
      participantIds[0]!,
    ]) {
      expect(response.headers.location).not.toContain(value);
      expect(response.headers.location).not.toContain(
        Buffer.from(value).toString("base64"),
      );
    }
  });

  it.each([0, 1])(
    "resolves the same vanity slug only within product %s",
    async (index) => {
      const response = await app!.inject({
        method: "GET",
        url: `/${products[index]!.slug}/SHARED-VANITY`,
      });

      expect(response.statusCode).toBe(307);
      const location = new URL(response.headers.location!);
      expect(location.origin).toBe(
        index === 0 ? "https://shop.example" : "https://other.example",
      );
      expect(location.pathname).toBe(index === 0 ? "/offer" : "/join");
      expect(location.searchParams.getAll("refcode")).toEqual([codes[index]]);
      expect(location.searchParams.get("campaign")).toBe(
        index === 0 ? "summer" : "winter",
      );
      expect(location.searchParams.getAll("tag")).toEqual(
        index === 0 ? ["one", "two"] : [],
      );
      expect([...location.searchParams.keys()].sort()).toEqual(
        index === 0
          ? ["campaign", "refcode", "tag", "tag"]
          : ["campaign", "refcode"],
      );
      expect(location.hash).toBe(index === 0 ? "#checkout" : "#signup");
    },
  );

  it("does not resolve another product's vanity link through an unknown product", async () => {
    const response = await app!.inject({
      method: "GET",
      url: `/missing-${suffix}/shared-vanity`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it("does not use a global referral code as a vanity link for another product", async () => {
    const response = await app!.inject({
      method: "GET",
      url: `/${products[1]!.slug}/${codes[0]}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it("does not redirect an unknown global code", async () => {
    const response = await app!.inject({
      method: "GET",
      url: `/missing-${suffix}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });
});
