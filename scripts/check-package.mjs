#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required; run this check through npm run pack:check.");

const output = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});
const [report] = JSON.parse(output);
const packagedPaths = new Set((report?.files ?? []).map(file => file.path));
const requiredPaths = [
  "dist/tcgen-st-test-mcp.cjs",
  "dist/tcgen-st-test-mcp.exe",
  "schemas/dependency-bundle-hash-vectors.json",
  "schemas/normalization-report.schema.json",
  "schemas/semantic-report.schema.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md"
];
const missing = requiredPaths.filter(path => !packagedPaths.has(path));
if (missing.length > 0) {
  throw new Error(`npm pack is missing required product files: ${missing.join(", ")}`);
}

console.log(`npm pack dry-run includes ${report.files.length} files and the self-contained MCP bundle.`);
