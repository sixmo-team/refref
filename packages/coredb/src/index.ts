import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const poolOptions = { max: 3, idle_timeout: 20, connect_timeout: 5 };

/**
 * Cache the database connections in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  connections: Map<string, postgres.Sql>;
};

if (!globalForDb.connections) {
  globalForDb.connections = new Map();
}

/**
 * Creates a database connection with the provided URL
 * @param databaseUrl - The PostgreSQL connection string
 * @returns Drizzle database instance
 */
export function createDb(databaseUrl: string) {
  const isDev = process.env.NODE_ENV === "development";

  let conn: postgres.Sql;

  if (isDev) {
    // In development, cache connections by URL
    const cachedConn = globalForDb.connections.get(databaseUrl);
    if (cachedConn) {
      conn = cachedConn;
    } else {
      conn = postgres(databaseUrl, poolOptions);
      globalForDb.connections.set(databaseUrl, conn);
    }
  } else {
    // In production, create new connection
    conn = postgres(databaseUrl, poolOptions);
  }

  return drizzle(conn, { schema });
}

export type DBType = ReturnType<typeof createDb>;

// Export schema for direct imports
export * as schema from "./schema.js";

// Export organization-level service account utilities
export * from "./lib/organization-service-account.js";
export * from "./reward-engine.js";
export * from "./referrals.js";
export * from "./payouts.js";
