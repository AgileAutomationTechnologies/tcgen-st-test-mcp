import { createInterface } from "node:readline";
import { packageVersion } from "../version.js";
import { toolDefinitions, toolHandlers } from "./tools.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export async function startStdioServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = await handleRequest(request);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify(errorResponse(null, -32700, error instanceof Error ? error.message : String(error))) + "\n");
    }
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "tcgen-st-test-mcp", version: packageVersion }
        }
      };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const handler = toolHandlers[name];
      if (!handler) return errorResponse(id, -32602, `Unknown tool '${name}'.`);
      const structuredContent = await handler(args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
          isError: hasBlockingDiagnostics(structuredContent)
        }
      };
    }
    default:
      return errorResponse(id, -32601, `Unsupported method '${request.method}'.`);
  }
}

function hasBlockingDiagnostics(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const diagnostics = (value as { diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics) && diagnostics.some(item => Boolean((item as { blocking?: unknown }).blocking));
}

function errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}
