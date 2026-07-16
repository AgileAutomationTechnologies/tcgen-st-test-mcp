import { createInterface } from "node:readline";
import { packageVersion } from "../version.js";
import { toolDefinitions, toolHandlers } from "./tools.js";
import type { ToolProgress } from "./tools.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcNotificationSink = (notification: Record<string, unknown>) => void;
const activeToolRequests = new Map<string, AbortController>();

export async function startStdioServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    const work = processStdioLine(line).finally(() => inFlight.delete(work));
    inFlight.add(work);
  }
  await Promise.allSettled([...inFlight]);
}

async function processStdioLine(line: string): Promise<void> {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    const response = await handleRequest(request, writeStdioMessage);
    if (response) writeStdioMessage(response);
  } catch (error) {
    writeStdioMessage(errorResponse(
      null,
      -32700,
      error instanceof Error ? error.message : String(error)
    ));
  }
}

function writeStdioMessage(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

export async function handleRequest(
  request: JsonRpcRequest,
  notify?: JsonRpcNotificationSink
): Promise<Record<string, unknown> | undefined> {
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
    case "notifications/cancelled": {
      const requestId = request.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        activeToolRequests.get(requestKey(requestId))?.abort();
      }
      return undefined;
    }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const handler = toolHandlers[name];
      if (!handler) return errorResponse(id, -32602, `Unknown tool '${name}'.`);
      const progressToken = progressTokenFrom(params._meta);
      const controller = new AbortController();
      const key = requestKey(id);
      if (activeToolRequests.has(key)) {
        return errorResponse(id, -32600, `A tool request with id '${String(id)}' is already active.`);
      }
      activeToolRequests.set(key, controller);
      let structuredContent: unknown;
      try {
        structuredContent = await handler(args, {
          signal: controller.signal,
          ...(progressToken === undefined
            ? {}
            : { reportProgress: progressReporter(progressToken, notify) })
        });
      } finally {
        activeToolRequests.delete(key);
      }
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

function progressReporter(
  progressToken: string | number,
  notify: JsonRpcNotificationSink | undefined
): (update: ToolProgress) => void {
  return (update: ToolProgress) => {
    try {
      notify?.({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken,
          progress: update.progress,
          total: update.total,
          message: update.message,
          ...(update.tcgen ? { tcgen: update.tcgen } : {})
        }
      });
    } catch {
      // Progress is advisory. A disconnected observer must not alter the
      // authoritative semantic result.
    }
  };
}

function requestKey(id: string | number | null): string {
  return `${typeof id}:${String(id)}`;
}

function progressTokenFrom(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const token = (value as { progressToken?: unknown }).progressToken;
  return typeof token === "string" || typeof token === "number"
    ? token
    : undefined;
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
