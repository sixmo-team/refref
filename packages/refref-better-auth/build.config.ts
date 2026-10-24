import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: [
    {
      input: "./src/index",
      outDir: "./dist",
      name: "index",
      format: ["cjs", "esm"],
    },
  ],
  declaration: true,
  clean: true,
  failOnWarn: false, // Don't fail on warnings
  rollup: {
    inlineDependencies: ["@refref/types"],
    emitCJS: true,
    esbuild: {
      target: "node16",
      exclude: [/node_modules/, /\.d\.[cm]?ts$/],
    },
  },
  externals: ["better-auth", "zod"],
});
