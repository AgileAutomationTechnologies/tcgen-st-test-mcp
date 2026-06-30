#!/usr/bin/env node
import { runCli } from "../mcp/tools.js";

process.exitCode = await runCli(process.argv);
