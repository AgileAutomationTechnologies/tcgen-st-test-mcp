#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("The tcgen-st-test-mcp.exe smoke test must run on Windows.");
}

const executable = resolve("dist", "tcgen-st-test-mcp.exe");
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const isolatedWorkingDirectory = mkdtempSync(join(tmpdir(), "tcgen-st-test-exe-"));
const fakeStrucppCli = join(isolatedWorkingDirectory, "fake-strucpp.mjs");
writeFileSync(
  fakeStrucppCli,
  [
    "if (process.argv.includes('--version')) {",
    "  console.log('STruC++ version 0.5.12');",
    "  process.exit(0);",
    "}",
    "process.exit(2);"
  ].join("\n"),
  "utf8"
);
const input = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tcgen_st_backend_check", arguments: {} } }),
  ""
].join("\n");

try {
  const messages = invokeExecutable({
    ...process.env,
    STRUCPP_PATH: fakeStrucppCli,
    STRUCPP_GPP_PATH: process.execPath,
    TCGEN_ST_NODE_PATH: process.execPath
  });
  const serverInfo = messages.find(message => message.id === 1)?.result?.serverInfo;
  const tools = messages.find(message => message.id === 2)?.result?.tools ?? [];
  const backendCheck = messages.find(message => message.id === 3)?.result?.structuredContent;
  if (
    serverInfo?.name !== "tcgen-st-test-mcp" ||
    serverInfo?.version !== packageVersion ||
    tools.length !== 4 ||
    backendCheck?.available !== true ||
    !String(backendCheck?.version ?? "").includes("0.5.12")
  ) {
    throw new Error(
      `Unexpected executable MCP response: server=${serverInfo?.name}@${serverInfo?.version}; tools=${tools.length}; backend=${backendCheck?.available}@${backendCheck?.version}`
    );
  }
  const missingNodeMessages = invokeExecutable({
    ...process.env,
    PATH: "",
    Path: "",
    STRUCPP_PATH: fakeStrucppCli,
    STRUCPP_GPP_PATH: process.execPath,
    TCGEN_ST_NODE_PATH: ""
  });
  const missingNodeCheck = missingNodeMessages.find(message => message.id === 3)?.result?.structuredContent;
  if (
    missingNodeCheck?.available !== false ||
    !missingNodeCheck?.diagnostics?.some(diagnostic => diagnostic.code === "STRUCPP_NODE_RUNTIME_NOT_FOUND" && diagnostic.blocking)
  ) {
    throw new Error(`Packaged JavaScript backend did not fail closed without external Node: ${JSON.stringify(missingNodeCheck)}`);
  }
  console.log("Standalone Windows MCP executable starts without a host Node runtime, exposes all tools, and uses explicit external Node only for a JavaScript STruC++ CLI.");
} finally {
  rmSync(isolatedWorkingDirectory, { recursive: true, force: true });
}

function invokeExecutable(env) {
  const output = execFileSync(executable, [], {
    cwd: isolatedWorkingDirectory,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    env
  });
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
