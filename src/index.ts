#!/usr/bin/env node
import { startStdioServer } from "./mcp/server.js";

startStdioServer().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
