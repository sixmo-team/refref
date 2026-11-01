import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createDb, schema } from "@refref/coredb";
import { getAuth } from "@refref/auth";
import { eq, inArray } from "drizzle-orm";

const databaseURL = process.env.TEST_DATABASE_URL;
if (!databaseURL || !new URL(databaseURL).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to a dedicated test database");
}
process.env.BETTER_AUTH_SECRET =
  "isolated-auth-regression-secret-at-least-thirty-two-characters";
const db = createDb(databaseURL);
const baseURL = "http://localhost:4000";
const entry = "/participant-portal/join/auth-regression-program";
const password = "Original-regression-password-123!";
const emails: string[] = [];
const organizations: string[] = [];
const sent: SendEmailCommand[] = [];
const auth = getAuth({
  baseURL,
  db,
  schema,
  enabledSocialAuth: [],
  enablePasswordAuth: true,
  enableMagicLinkAuth: true,
  postbox: {
    from: "RefRef <auth@example.test>",
    credentials: {
      accessKeyId: "isolated-test-key",
      secretAccessKey: "isolated-test-secret",
    },
  },
});
const transport = vi.spyOn(SESv2Client.prototype, "send");
beforeEach(() => {
  sent.length = 0;
  transport.mockImplementation(async (command) => {
    if (!(command instanceof SendEmailCommand))
      throw new Error("Unexpected auth mail command");
    sent.push(command);
    return { $metadata: {}, MessageId: "isolated-test-message" };
  });
});
afterAll(async () => {
  transport.mockRestore();
  if (organizations.length)
    await db.delete(schema.org).where(inArray(schema.org.id, organizations));
  if (emails.length)
    await db.delete(schema.user).where(inArray(schema.user.email, emails));
  await db.$client.end();
});
function mailLink(index = sent.length - 1) {
  const html = sent[index]?.input.Content?.Simple?.Body?.Html?.Data ?? "";
  const href = /href="([^"]*\/api\/auth\/[^"]+)"/.exec(html)?.[1];
  expect(href).toBeTruthy();
  return new URL(href!.replaceAll("&amp;", "&"));
}
async function signUp(callbackURL = entry) {
  const email = `native-auth-${randomUUID()}@example.test`;
  emails.push(email);
  const response = await auth.api.signUpEmail({
    body: { email, name: "Independent partner", password, callbackURL },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  await vi.waitFor(() =>
    expect(sent.at(-1)?.input.Destination?.ToAddresses).toEqual([email]),
  );
  return email;
}
async function user(email: string) {
  return (
    await db.select().from(schema.user).where(eq(schema.user.email, email))
  )[0];
}

describe("Native authentication over independent Postbox", () => {
  it("leaves signup unverified until its native token is consumed and returns to the programme", async () => {
    const email = await signUp();
    expect((await user(email))?.emailVerified).toBe(false);
    expect(sent[0]?.input).toMatchObject({
      FromEmailAddress: "RefRef <auth@example.test>",
      Destination: { ToAddresses: [email] },
    });
    const url = mailLink();
    expect(url.searchParams.get("callbackURL")).toBe(entry);
    const verified = await auth.handler(new Request(url));
    expect(verified.status).toBe(302);
    expect(verified.headers.get("set-cookie")).toContain(
      "refref.session_token",
    );
    expect(new URL(verified.headers.get("location")!, baseURL).pathname).toBe(
      entry,
    );
    expect((await user(email))?.emailVerified).toBe(true);
    const login = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    expect(login.status).toBe(200);
  });

  it("resends a native verification link without verifying or enrolling the account", async () => {
    const email = await signUp();
    await auth.api.sendVerificationEmail({
      body: { email, callbackURL: entry },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(mailLink().searchParams.get("callbackURL")).toBe(entry);
    expect((await user(email))?.emailVerified).toBe(false);
  });

  it("resets only the intended password and consumes the native token once", async () => {
    const email = await signUp();
    await auth.handler(new Request(mailLink()));
    const other = await signUp();
    await auth.handler(new Request(mailLink()));
    const resetPage = `/auth/reset-password?redirectTo=${encodeURIComponent(entry)}`;
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: resetPage },
    });
    await vi.waitFor(() =>
      expect(sent.at(-1)?.input.Content?.Simple?.Subject?.Data).toBe(
        "Reset your password",
      ),
    );
    const callback = await auth.handler(new Request(mailLink()));
    const destination = new URL(callback.headers.get("location")!, baseURL);
    expect(destination.pathname).toBe("/auth/reset-password");
    expect(destination.searchParams.get("redirectTo")).toBe(entry);
    const token = destination.searchParams.get("token")!;
    const newPassword = "Replacement-regression-password-456!";
    await auth.api.resetPassword({ body: { token, newPassword } });
    await expect(
      auth.api.resetPassword({ body: { token, newPassword } }),
    ).rejects.toThrow();
    expect(
      (
        await auth.api.signInEmail({
          body: { email, password: newPassword },
          asResponse: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await auth.api.signInEmail({
          body: { email, password },
          asResponse: true,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await auth.api.signInEmail({
          body: { email: other, password },
          asResponse: true,
        })
      ).status,
    ).toBe(200);
  });

  it.each([
    "https://foreign.example/path",
    "//foreign.example/path",
    "/\\foreign.example/path",
    "/participant-portal/join/program?email=private@example.test",
    "/auth/reset-password?redirectTo=https%3A%2F%2Fforeign.example",
  ])(
    "rejects an unsafe return destination %s before sending",
    async (destination) => {
      const before = sent.length;
      const response = await auth.handler(
        new Request(`${baseURL}/api/auth/request-password-reset`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({
            email: "absent@example.test",
            redirectTo: destination,
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(sent).toHaveLength(before);
    },
  );

  it("preserves optional magic-link sign-in using its own template", async () => {
    const email = await signUp();
    await auth.api.signInMagicLink({
      body: { email, callbackURL: entry },
      headers: new Headers(),
    });
    await vi.waitFor(() =>
      expect(mailLink().pathname).toBe("/api/auth/magic-link/verify"),
    );
  });

  it("preserves native organization invitations and their distinct acceptance link", async () => {
    const email = await signUp();
    await auth.handler(new Request(mailLink()));
    const login = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = new Headers({ cookie });
    const organization = await auth.api.createOrganization({
      headers,
      body: { name: "Native auth regression", slug: `native-${randomUUID()}` },
    });
    expect(organization).toBeTruthy();
    organizations.push(organization!.id);
    await auth.api.createInvitation({
      headers,
      body: {
        email: `invited-${randomUUID()}@example.test`,
        role: "member",
        organizationId: organization!.id,
      },
    });
    await vi.waitFor(() =>
      expect(sent.at(-1)?.input.Content?.Simple?.Subject?.Data).toBe(
        "You've been invited to RefRef",
      ),
    );
    const invitation = sent.at(-1)!.input;
    expect(invitation.Content?.Simple?.Body?.Html?.Data).toContain(
      `${baseURL}/accept-invitation/`,
    );
    expect(invitation.Content?.Simple?.Body?.Html?.Data).not.toContain(
      "Reset your password",
    );
  });

  it.each(["reset", "verification"] as const)(
    "keeps %s responses independent of recipient existence and mail-provider completion",
    async (kind) => {
      const email = await signUp();
      let releaseProvider!: () => void;
      const provider = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      transport.mockImplementationOnce(async (command) => {
        if (!(command instanceof SendEmailCommand))
          throw new Error("Unexpected auth mail command");
        sent.push(command);
        await provider;
        return { $metadata: {}, MessageId: "isolated-delayed-message" };
      });
      const request = (email: string) =>
        kind === "reset"
          ? auth.api.requestPasswordReset({
              body: { email, redirectTo: "/auth/reset-password" },
            })
          : auth.api.sendVerificationEmail({
              body: { email, callbackURL: entry },
            });
      let completed = false;
      const existing = request(email).then((response) => {
        completed = true;
        return response;
      });
      try {
        await vi.waitFor(() =>
          expect(sent.at(-1)?.input.Content?.Simple?.Subject?.Data).toBe(
            kind === "reset"
              ? "Reset your password"
              : "Verify your email address",
          ),
        );
        const absent = await request(`absent-${randomUUID()}@example.test`);
        await vi.waitFor(() => expect(completed).toBe(true));
        expect(absent).toEqual(await existing);
      } finally {
        releaseProvider();
        await existing;
      }
    },
  );

  it("reports asynchronous mail failure without recipient or bearer diagnostics", async () => {
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    transport.mockRejectedValueOnce(
      new Error("private@example.test?token=do-not-log"),
    );
    try {
      await auth.options.emailVerification!.sendVerificationEmail!({
        user: {
          id: "test",
          name: "Test",
          email: "private@example.test",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        url: `${baseURL}/api/auth/verify-email?token=private`,
        token: "private",
      });
      await vi.waitFor(() =>
        expect(diagnostics.mock.calls).toContainEqual([
          expect.any(String),
          { level: "error" },
        ]),
      );
      const logged = JSON.stringify(diagnostics.mock.calls);
      expect(logged).not.toContain("private@example.test");
      expect(logged).not.toContain("token=private");
      expect(logged).not.toContain("do-not-log");
    } finally {
      diagnostics.mockRestore();
    }
  });
});
