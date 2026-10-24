import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/refref") {
  throw new Error("Migration requires the dedicated refref database");
}
const sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 5 });
try {
  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  // Event definitions are application vocabulary, not demonstration tenant data.
  for (const [type, name] of [["signup", "Sign up"], ["purchase", "Purchase"]]) {
    await sql`INSERT INTO event_definition (id, name, type, config)
      VALUES (${`evd_${randomUUID()}`}, ${name}, ${type}, ${JSON.stringify({ schemaVersion: 1 })}::jsonb)
      ON CONFLICT (type) DO NOTHING`;
  }
  console.log("RefRef schema migrations applied; no demo tenant data seeded.");
} finally {
  await sql.end();
}
