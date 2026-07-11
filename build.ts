import { build } from "esbuild";
import type { BuildOptions } from "esbuild";
import { copyFile, mkdir } from "fs/promises";
import { dirname } from "path";

import pkg from "./package.json";

const baseOptions: BuildOptions = {
  outbase: "src",
  outdir: "dist",
  target: "ES2022",
  format: "esm",
  minify: true,
  tsconfig: "tsconfig.build.json",
};

await build({
  ...baseOptions,
  entryPoints: ["src/index.ts"],
  platform: "node",
  bundle: true,
  external: Object.keys(pkg.dependencies),
  banner: {
    js: "#!/usr/bin/env node",
  },
});

const schemaOutputPath = "dist/schema.json";
await mkdir(dirname(schemaOutputPath), { recursive: true });
await copyFile("schema/diff2prompt.schema.json", schemaOutputPath);
