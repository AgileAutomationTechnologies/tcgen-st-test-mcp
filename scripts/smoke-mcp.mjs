#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("examples/adder/request.json", "utf8"));
const child = spawn(process.execPath, ["dist/index.js"], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.on("data", chunk => {
  stdout += chunk.toString();
});
child.stderr.on("data", chunk => {
  stderr += chunk.toString();
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "tcgen_st_test_run", arguments: fixture }
});
child.stdin.end();

const timer = setTimeout(() => {
  child.kill("SIGKILL");
}, 60_000);

child.on("close", code => {
  clearTimeout(timer);
  const messages = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const serverName = messages.find(message => message.id === 1)?.result?.serverInfo?.name;
  const tools = messages.find(message => message.id === 2)?.result?.tools?.map(tool => tool.name) ?? [];
  const report = messages.find(message => message.id === 3)?.result?.structuredContent;
  console.log(
    JSON.stringify(
      {
        code,
        serverName,
        tools,
        verdict: report?.verdict,
        passed: report?.summary?.passed,
        failed: report?.summary?.failed
      },
      null,
      2
    )
  );
  if (stderr) console.error(stderr);
  if (
    code !== 0 ||
    serverName !== "tcgen-st-test-mcp" ||
    tools.length !== 4 ||
    report?.verdict !== "passed" ||
    report?.summary?.passed !== 1
  ) {
    process.exit(1);
  }
});

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}
