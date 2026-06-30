#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const cli = join("dist", "cli", "main.js");
const examplesDir = "examples";
const requests = readdirSync(examplesDir)
  .map(name => ({ name, path: join(examplesDir, name, "request.json") }))
  .filter(item => statSync(join(examplesDir, item.name)).isDirectory());

for (const request of requests) {
  const normalize = runJson(cli, ["normalize", request.path]);
  const generate = runJson(cli, ["generate", request.path]);
  const report = runJson(cli, ["run", request.path]);
  const generatedBytes = generate.generatedTestFile?.content?.length ?? 0;
  console.log(
    `${request.name}: normalize=${normalize.compatibilityStatus}; testBytes=${generatedBytes}; verdict=${report.verdict}; passed=${report.summary?.passed ?? 0}; failed=${report.summary?.failed ?? 0}`
  );
  if (report.verdict !== "passed") {
    if (report.artifacts?.stderr) console.error(report.artifacts.stderr);
    console.error(JSON.stringify(report.diagnostics ?? [], null, 2));
    process.exit(1);
  }
}

function runJson(entrypoint, args) {
  const output = execFileSync(process.execPath, [entrypoint, ...args], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}
