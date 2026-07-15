import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { SemanticTestReport } from "../src/domain/models.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager.js";
import { loadRequest, withEnv } from "./helpers.js";

describe("semantic workspace cleanup", () => {
  it("removes a completed semantic workspace with bounded retry options", async () => {
    const manager = new WorkspaceManager();
    const workspace = await manager.create();
    await manager.writeFiles(workspace, [{ path: "nested/result.txt", content: "done" }]);

    const result = await manager.cleanup(workspace, false);

    expect(result).toEqual({ removed: true, retained: false });
    expect(existsSync(workspace)).toBe(false);
  });

  it("reports exhausted cleanup without throwing or exposing the workspace path", async () => {
    let options: Record<string, unknown> | undefined;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = new WorkspaceManager(async (_root, removeOptions) => {
      options = removeOptions;
      throw new Error("C:\\secret\\tcgen-st-test-locked is busy");
    });
    try {
      const result = await manager.cleanup("C:\\secret\\tcgen-st-test-locked", false);

      expect(result).toEqual({
        removed: false,
        retained: true,
        diagnosticCode: "SANDBOX_WORKSPACE_CLEANUP_FAILED"
      });
      expect(options).toMatchObject({ recursive: true, force: true, retryDelay: 125 });
      expect(Number(options?.maxRetries)).toBeGreaterThan(0);
      expect(warning).toHaveBeenCalledWith(
        "[tcgen-st-test] Semantic workspace cleanup failed after bounded retries."
      );
      expect(warning.mock.calls.flat().join(" ")).not.toContain("secret");
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps the primary semantic verdict when cleanup exhaustion is reported", async () => {
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue({
      status: "failed",
      executionAttempted: true,
      stdout: "FAIL: adds two integers: expected 5",
      stderr: "",
      exitCode: 1,
      durationMs: 1,
      diagnostics: [],
      tests: [{ name: "adds two integers", status: "failed", message: "expected 5" }]
    });
    const cleanup = vi.spyOn(WorkspaceManager.prototype, "cleanup").mockImplementation(
      async workspace => {
        await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
        return {
          removed: false,
          retained: true,
          diagnosticCode: "SANDBOX_WORKSPACE_CLEANUP_FAILED"
        };
      }
    );
    try {
      const report = (await toolHandlers.tcgen_st_test_run(
        loadRequest("adder") as unknown as Record<string, unknown>
      )) as SemanticTestReport;

      expect(report.verdict).toBe("failed");
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "SANDBOX_WORKSPACE_CLEANUP_FAILED",
          severity: "warning",
          blocking: false
        })
      );
      expect(report.diagnostics.map(item => item.message).join("\n")).not.toMatch(
        /[A-Za-z]:[\\/][^\r\n]*tcgen-st-test-/i
      );
    } finally {
      cleanup.mockRestore();
      backend.mockRestore();
    }
  });

  it("waits for a timed-out process tree before its workspace is removed", async () => {
    const gpp = configuredGpp();
    if (!gpp) return;
    const manager = new WorkspaceManager();
    const workspace = await createHangingFixture(manager);
    const fakeCli = join(workspace, "fake-strucpp.mjs");
    try {
      const result = await withEnv(
        { STRUCPP_PATH: fakeCli, STRUCPP_GPP_PATH: gpp },
        () => new StrucppBackend().run(
          [join(workspace, "source.st")],
          join(workspace, "test.st"),
          { timeoutMs: 1_000 }
        )
      );

      expect(result.status).toBe("timeout");
      expect(result.diagnostics.map(item => item.code)).toContain("SANDBOX_TIMEOUT");
    } finally {
      const cleanup = await manager.cleanup(workspace, false);
      expect(cleanup.removed).toBe(true);
      expect(existsSync(workspace)).toBe(false);
    }
  }, 15_000);

  it("waits for a cancelled process tree before its workspace is removed", async () => {
    const gpp = configuredGpp();
    if (!gpp) return;
    const manager = new WorkspaceManager();
    const workspace = await createHangingFixture(manager);
    const marker = join(workspace, "child-started.txt");
    const controller = new AbortController();
    try {
      const run = withEnv(
        {
          STRUCPP_PATH: join(workspace, "fake-strucpp.mjs"),
          STRUCPP_GPP_PATH: gpp
        },
        () => new StrucppBackend().run(
          [join(workspace, "source.st")],
          join(workspace, "test.st"),
          { timeoutMs: 30_000, signal: controller.signal }
        )
      );
      await waitForFile(marker);
      controller.abort();
      const result = await run;

      expect(result.status).toBe("backend_error");
      expect(result.diagnostics.map(item => item.code)).toContain("SANDBOX_CANCELLED");
    } finally {
      controller.abort();
      const cleanup = await manager.cleanup(workspace, false);
      expect(cleanup.removed).toBe(true);
      expect(existsSync(workspace)).toBe(false);
    }
  }, 15_000);
});

async function createHangingFixture(manager: WorkspaceManager): Promise<string> {
  const workspace = await manager.create();
  await manager.writeFiles(workspace, [
    { path: "source.st", content: "FUNCTION_BLOCK FB_Cleanup\nEND_FUNCTION_BLOCK\n" },
    { path: "test.st", content: "TEST 'cleanup'\nASSERT_TRUE(TRUE);\nEND_TEST\n" },
    {
      path: "fake-strucpp.mjs",
      content: [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "if (process.argv.includes('--version')) {",
        "  console.log('STruC++ version 0.5.13-tcgen.2');",
        "  process.exit(0);",
        "}",
        "writeFileSync(join(process.env.STRUCPP_TEST_TEMP_ROOT, 'child-started.txt'), 'started');",
        "setInterval(() => {}, 1000);"
      ].join("\n")
    }
  ]);
  return workspace;
}

function configuredGpp(): string | undefined {
  const candidate = process.env.STRUCPP_GPP_PATH ?? "C:\\msys64\\ucrt64\\bin\\g++.exe";
  return existsSync(candidate) ? candidate : undefined;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("The fake STruC++ child did not start within five seconds.");
}
