import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const apiRequire = createRequire(
  new URL("./apps/api/package.json", import.meta.url),
);

export default {
  esbuild: { jsx: "automatic" },
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
    include: [
      "apps/webapp/src/server/api/security.integration.test.ts",
      "apps/webapp/src/server/api/referral-first-payment.integration.test.ts",
      "apps/webapp/src/lib/__tests__/referral-first-payment.test.ts",
      "apps/webapp/src/lib/__tests__/auth-email-privacy.test.ts",
      "apps/webapp/src/lib/__tests__/onboarding-validation.test.ts",
      "apps/refer/test/referral-redirect.test.ts",
    ],
  },
  resolve: {
    alias: [
      { find: /^fastify$/, replacement: apiRequire.resolve("fastify") },
      {
        find: /^@refref\/coredb\/security$/,
        replacement: source("./packages/coredb/src/security.ts"),
      },
      {
        find: /^@refref\/coredb\/schema$/,
        replacement: source("./packages/coredb/src/schema.ts"),
      },
      ...["coredb", "types", "id", "utils", "auth", "email-templates"].map(
        (name) => ({
          find: new RegExp(`^@refref/${name}$`),
          replacement: source(`./packages/${name}/src/index.ts`),
        }),
      ),
      { find: "@", replacement: source("./apps/webapp/src") },
    ],
  },
};
