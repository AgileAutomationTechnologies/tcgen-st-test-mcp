import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { copyStandardFunctionBlockContracts } from "../src/backends/StandardFunctionBlockContracts.js";
import { handleRequest } from "../src/mcp/server.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("MCP request-bound progress", () => {
  it("emits progress notifications without forwarding the token into tool arguments", async () => {
    const handler = vi.spyOn(toolHandlers, "tcgen_st_normalize").mockImplementation(
      async (args, context) => {
        expect(args).toEqual({ candidateSourcePath: "cut.st", sources: [] });
        expect(args).not.toHaveProperty("_meta");
        context?.reportProgress?.({ progress: 0, total: 1, message: "starting" });
        context?.reportProgress?.({ progress: 1, total: 1, message: "complete" });
        return { diagnostics: [] };
      }
    );
    const notifications: Array<Record<string, unknown>> = [];
    try {
      const response = await handleRequest(
        {
          jsonrpc: "2.0",
          id: 17,
          method: "tools/call",
          params: {
            name: "tcgen_st_normalize",
            arguments: { candidateSourcePath: "cut.st", sources: [] },
            _meta: { progressToken: "request-17" }
          }
        },
        notification => notifications.push(notification)
      );

      expect(response).toMatchObject({ id: 17, result: { isError: false } });
      expect(notifications).toEqual([
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: "request-17",
            progress: 0,
            total: 1,
            message: "starting"
          }
        },
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: "request-17",
            progress: 1,
            total: 1,
            message: "complete"
          }
        }
      ]);
    } finally {
      handler.mockRestore();
    }
  });

  it("does not emit notifications when the caller did not provide a token", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const response = await handleRequest(
      { jsonrpc: "2.0", id: 18, method: "tools/list" },
      notification => notifications.push(notification)
    );
    expect(response).toMatchObject({ id: 18 });
    expect(notifications).toEqual([]);
  });

  it("publishes stable queued assertion-checkpoint identities", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: {
          name: "tcgen_st_test_generate",
          arguments: loadRequest("framework-limit-counter") as unknown as Record<string, unknown>,
          _meta: { progressToken: "framework-design-19" }
        }
      },
      notification => notifications.push(notification)
    );

    const checkpoints = notifications
      .map(notification => notification.params as {
        progressToken?: unknown;
        tcgen?: Record<string, unknown>;
      })
      .filter(params => params.tcgen?.kind === "assertion_checkpoint");
    expect(checkpoints).toHaveLength(4);
    expect(checkpoints.map(params => params.tcgen)).toEqual([
      1, 2, 3, 4
    ].map(ordinal => expect.objectContaining({
      contract: "tcgen-framework-assertion-progress-v1",
      kind: "assertion_checkpoint",
      phase: "queued",
      checkpointId: expect.stringMatching(/^checkpoint:[a-f0-9]{64}$/),
      assertionId: expect.stringMatching(/^assertion:[a-f0-9]{64}$/),
      testFunctionBlock: "FB_Test_LimitCounter",
      checkpointTestName: expect.stringMatching(/^framework checkpoint FB_Test_LimitCounter /),
      ordinal,
      sourceLine: expect.any(Number),
      status: "not_run"
    })));
    expect(checkpoints.map(params => params.tcgen?.sourceLine)).toEqual(
      (await toolHandlers.tcgen_st_test_generate(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as { assertions: Array<{ sourceLine: number }> }).assertions.map(assertion => assertion.sourceLine)
    );
    expect(checkpoints.every(params => params.progressToken === "framework-design-19")).toBe(true);
  });

  it("forwards a completed assertion checkpoint while the backend run is still active", async () => {
    const request = loadRequest("framework-limit-counter");
    const generated = await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    ) as {
      generatedTestNames: string[];
      assertions: Array<{
        assertionId: string;
        checkpointId: string;
        checkpointTestName: string;
        sourceLine: number;
      }>;
    };
    const first = generated.assertions[0];
    let releaseBackend: (() => void) | undefined;
    const backendRelease = new Promise<void>(resolve => {
      releaseBackend = resolve;
    });
    let liveResultObserved: (() => void) | undefined;
    const liveResult = new Promise<void>(resolve => {
      liveResultObserved = resolve;
    });
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockImplementation(
      async (_sources, _test, options) => {
        options.onTestResult?.({
          name: first.checkpointTestName,
          status: "passed",
          startedAt: "2026-07-15T10:00:00.000Z",
          completedAt: "2026-07-15T10:00:01.000Z"
        });
        liveResultObserved?.();
        await backendRelease;
        const tests = [
          ...generated.generatedTestNames,
          ...generated.assertions.map(assertion => assertion.checkpointTestName)
        ].map(name => ({
          name,
          status: "passed" as const,
          startedAt: "2026-07-15T10:00:00.000Z",
          completedAt: "2026-07-15T10:00:01.000Z"
        }));
        return {
          status: "passed",
          executionAttempted: true,
          stdout: tests.map(test => `PASS: ${test.name}`).join("\n"),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          diagnostics: [],
          tests,
          standardFunctionBlockContracts: copyStandardFunctionBlockContracts(),
          standardFunctionBlockContractQualified: true
        };
      }
    );
    const notifications: Array<Record<string, any>> = [];
    try {
      const call = handleRequest(
        {
          jsonrpc: "2.0",
          id: "live-framework-run",
          method: "tools/call",
          params: {
            name: "tcgen_st_test_run",
            arguments: request as unknown as Record<string, unknown>,
            _meta: { progressToken: "live-framework-token" }
          }
        },
        notification => notifications.push(notification)
      );
      await liveResult;

      expect(notifications).toContainEqual(expect.objectContaining({
        method: "notifications/progress",
        params: expect.objectContaining({
          progressToken: "live-framework-token",
          tcgen: expect.objectContaining({
            phase: "completed",
            assertionId: first.assertionId,
            checkpointId: first.checkpointId,
            sourceLine: first.sourceLine,
            reached: true,
            status: "passed",
            startedAt: "2026-07-15T10:00:00.000Z",
            completedAt: "2026-07-15T10:00:01.000Z"
          })
        })
      }));
      releaseBackend?.();
      await call;
    } finally {
      releaseBackend?.();
      backend.mockRestore();
    }
  });

  it("allows independent worker tool calls to execute concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    const handler = vi.spyOn(toolHandlers, "tcgen_st_normalize").mockImplementation(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      active--;
      return { diagnostics: [] };
    });
    try {
      await Promise.all([
        handleRequest({
          jsonrpc: "2.0",
          id: "worker-a",
          method: "tools/call",
          params: { name: "tcgen_st_normalize", arguments: {} }
        }),
        handleRequest({
          jsonrpc: "2.0",
          id: "worker-b",
          method: "tools/call",
          params: { name: "tcgen_st_normalize", arguments: {} }
        })
      ]);
      expect(maximumActive).toBe(2);
    } finally {
      handler.mockRestore();
    }
  });

  it("does not serialize independent semantic backend runs", async () => {
    let active = 0;
    let maximumActive = 0;
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockImplementation(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      active--;
      return {
        status: "passed",
        executionAttempted: true,
        stdout: "PASS: adds two integers",
        stderr: "",
        exitCode: 0,
        durationMs: 30,
        diagnostics: [],
        tests: [{ name: "adds two integers", status: "passed" }],
        standardFunctionBlockContracts: copyStandardFunctionBlockContracts(),
        standardFunctionBlockContractQualified: true
      };
    });
    try {
      const responses = await Promise.all(["semantic-a", "semantic-b"].map(id =>
        handleRequest({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "tcgen_st_test_run",
            arguments: loadRequest("adder") as unknown as Record<string, unknown>
          }
        })
      ));
      expect(maximumActive).toBe(2);
      expect(responses).toEqual([
        expect.objectContaining({ result: expect.objectContaining({
          structuredContent: expect.objectContaining({ verdict: "passed" })
        }) }),
        expect.objectContaining({ result: expect.objectContaining({
          structuredContent: expect.objectContaining({ verdict: "passed" })
        }) })
      ]);
    } finally {
      backend.mockRestore();
    }
  });

  it("routes an MCP cancellation notification to the active tool request", async () => {
    let observedSignal: AbortSignal | undefined;
    const handler = vi.spyOn(toolHandlers, "tcgen_st_normalize").mockImplementation(
      async (_args, context) => {
        observedSignal = context?.signal;
        await new Promise<void>(resolve => {
          if (context?.signal?.aborted) return resolve();
          context?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          diagnostics: [{
            severity: "error",
            blocking: true,
            code: "SANDBOX_CANCELLED",
            message: "cancelled"
          }]
        };
      }
    );
    try {
      const call = handleRequest({
        jsonrpc: "2.0",
        id: 91,
        method: "tools/call",
        params: { name: "tcgen_st_normalize", arguments: {} }
      });
      await Promise.resolve();
      await handleRequest({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 91, reason: "user aborted" }
      });
      const response = await call;

      expect(observedSignal?.aborted).toBe(true);
      expect(response).toMatchObject({
        id: 91,
        result: {
          isError: true,
          structuredContent: {
            diagnostics: [{ code: "SANDBOX_CANCELLED" }]
          }
        }
      });
    } finally {
      handler.mockRestore();
    }
  });

  it("aborts the matching semantic backend child through the tool handler", async () => {
    let backendSignal: AbortSignal | undefined;
    let backendStartedResolve: (() => void) | undefined;
    const backendStarted = new Promise<void>(resolve => {
      backendStartedResolve = resolve;
    });
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockImplementation(
      async (_sources, _test, options) => {
        backendSignal = options.signal;
        backendStartedResolve?.();
        await new Promise<void>(resolve => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          status: "backend_error",
          executionAttempted: true,
          stdout: "",
          stderr: "",
          exitCode: null,
          durationMs: 1,
          diagnostics: [{
            severity: "error",
            blocking: true,
            code: "SANDBOX_CANCELLED",
            message: "STruC++ execution was cancelled."
          }],
          tests: [],
          standardFunctionBlockContracts: copyStandardFunctionBlockContracts(),
          standardFunctionBlockContractQualified: true
        };
      }
    );
    try {
      const call = handleRequest({
        jsonrpc: "2.0",
        id: "semantic-worker-1",
        method: "tools/call",
        params: {
          name: "tcgen_st_test_run",
          arguments: loadRequest("adder") as unknown as Record<string, unknown>
        }
      });
      await backendStarted;
      await handleRequest({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "semantic-worker-1" }
      });
      const response = await call;

      expect(backendSignal?.aborted).toBe(true);
      expect(response).toMatchObject({
        id: "semantic-worker-1",
        result: {
          isError: true,
          structuredContent: {
            verdict: "backend_error",
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: "SANDBOX_CANCELLED" })
            ])
          }
        }
      });
    } finally {
      backend.mockRestore();
    }
  });
});
