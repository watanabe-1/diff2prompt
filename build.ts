import { build } from "esbuild";
import type { BuildOptions } from "esbuild";
import glob from "fast-glob";
import pkg from "./package.json";

const baseOptions: BuildOptions = {
  outbase: "src",
  outdir: "dist",
  target: "ES2022",
  format: "esm",
  minify: true,
  tsconfig: "tsconfig.build.json",
};

const entriesForCli = await glob(["src/index.ts"]);
const externals = [
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
];
await build({
  ...baseOptions,
  entryPoints: entriesForCli,
  platform: "node",
  bundle: true,
  external: externals,
  banner: {
    js: "#!/usr/bin/env node",
  },
});

const entriesForNext = await glob([
  "!src/**/types.ts",
  "!src/**/*-types.ts",
  "!src/**/*.test.ts",
]);
await build({
  ...baseOptions,
  entryPoints: entriesForNext,
  platform: "neutral",
  bundle: false,
});
