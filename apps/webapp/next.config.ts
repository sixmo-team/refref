import type { NextConfig } from "next";
import path from "node:path";
/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "@/env";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  experimental: {
    cpus: 1,
    workerThreads: false,
    webpackMemoryOptimizations: true,
    serverActions: { bodySizeLimit: "256kb" },
  },
  async redirects() {
    return [
      {
        source: "/settings",
        destination: "/settings/account/profile",
        permanent: true,
      },
    ];
  },
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@refref/ui"],
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default config;
