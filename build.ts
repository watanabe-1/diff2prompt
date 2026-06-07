import { build } from "esbuild";
import type { BuildOptions } from "esbuild";

import pkg from "./package.json";

const baseOptions: BuildOptions = {
  outbase: "src",
  outdir: "dist",
  target: "ES2022",
  format: "esm",
  minify: true,
  tsconfig: "tsconfig.build.json",
};

const externals = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)];
await build({
  ...baseOptions,
  entryPoints: ["src/index.ts"],
  platform: "node",
  bundle: true,
  external: externals,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
