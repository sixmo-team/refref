import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { config as baseConfig } from "@refref/eslint-config/base";
import { nextJsConfig } from "@refref/eslint-config/next-js";
import { config as reactConfig } from "@refref/eslint-config/react-internal";

const webappRequire = createRequire(new URL("./apps/webapp/package.json", import.meta.url));
const reactVersion = webappRequire("react/package.json").version;
const nextFiles = ["apps/{webapp,acme,www}/**/*.{js,mjs,ts,tsx}"];
const reactFiles = ["packages/{ui,widget,email-templates}/**/*.{js,mjs,ts,tsx}"];

export default [
  ...baseConfig,
  {
    ignores: [
      "**/.local/**",
      "**/.superpowers/**",
      "**/next-env.d.ts",
      // Keep the existing workspace exclusion, but lint this task's changed page.
      "apps/www/**/*",
      "!apps/www/**/",
      "!apps/www/components/ui/changelog.tsx",
    ],
  },
  ...nextJsConfig
    .filter((config) => !config.ignores)
    .map((config) => ({ ...config, files: nextFiles })),
  ...reactConfig
    .filter((config) => !config.ignores)
    .map((config) => ({ ...config, files: reactFiles })),
  {
    files: [...nextFiles, ...reactFiles],
    settings: { react: { version: reactVersion } },
  },
  {
    files: nextFiles,
    settings: {
      next: {
        rootDir: ["webapp", "acme", "www"].map((app) =>
          fileURLToPath(new URL(`./apps/${app}/`, import.meta.url)),
        ),
      },
    },
  },
  {
    files: ["packages/ui/src/types/data-table.ts"],
    // TanStack requires these exact merger parameters; tsc checks unused code.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^(TData|TValue)$" },
      ],
    },
  },
];
