import { createDb, schema } from "@refref/coredb";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
const email = process.env.REFREF_DEV_EMAIL;
const password = process.env.REFREF_DEV_PASSWORD;
if (!url || new URL(url).pathname !== "/refref") {
  throw new Error("Bootstrap requires the dedicated refref database");
}
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 16) {
  throw new Error("Generate private development credentials with scripts/dev.mjs init first");
}
const db = createDb(url);
try {
  const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  if (existing) {
    console.log("Development account already exists; no account data or credentials changed.");
  } else {
    const hash = await hashPassword(password);
    await db.transaction(async (tx) => {
      const [user] = await tx.insert(schema.user).values({ name: "Local developer", email, emailVerified: true }).returning();
      await tx.insert(schema.account).values({ userId: user.id, accountId: user.id, providerId: "credential", password: hash });
      const [org] = await tx.insert(schema.org).values({ name: "Local development", slug: `dev-${randomUUID()}` }).returning();
      await tx.insert(schema.orgUser).values({ orgId: org.id, userId: user.id, role: "owner" });
    });
    console.log("Operator-only verified development account created. Credentials remain in .local/credentials.txt.");
  }
} finally {
  await db.$client.end();
}
