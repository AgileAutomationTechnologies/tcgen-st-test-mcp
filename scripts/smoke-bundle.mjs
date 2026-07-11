#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const bundle = resolve("dist", "tcgen-st-test-mcp.cjs");
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const isolatedWorkingDirectory = mkdtempSync(join(tmpdir(), "tcgen-st-test-bundle-"));
const input = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  ""
].join("\n");

try {
  const output = execFileSync(process.execPath, [bundle], {
    cwd: isolatedWorkingDirectory,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"]
  });
  const messages = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const serverName = messages.find(message => message.id === 1)?.result?.serverInfo?.name;
  const serverVersion = messages.find(message => message.id === 1)?.result?.serverInfo?.version;
  const tools = messages.find(message => message.id === 2)?.result?.tools ?? [];
  if (serverName !== "tcgen-st-test-mcp" || serverVersion !== packageVersion || tools.length !== 4) {
    throw new Error(`Unexpected bundled MCP response: server=${serverName}@${serverVersion}; tools=${tools.length}`);
  }
  console.log("Self-contained MCP bundle starts outside the repository and exposes all tools.");
} finally {
  rmSync(isolatedWorkingDirectory, { recursive: true, force: true });
}
