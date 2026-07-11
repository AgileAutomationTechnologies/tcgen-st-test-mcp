#!/usr/bin/env node
import { build } from "esbuild";

await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["src/index.ts"],
  outfile: "dist/tcgen-st-test-mcp.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  packages: "bundle",
  charset: "utf8",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  logLevel: "info"
});
