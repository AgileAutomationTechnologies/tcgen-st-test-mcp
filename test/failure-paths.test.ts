import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SemanticTestReport } from "../src/domain/models.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest, loadTestFixture, localStrucppRepo, withEnv } from "./helpers.js";

describe("failure paths", () => {
  it("returns backend_error when STruC++ is missing", async () => {
    await withEnv({ STRUCPP_PATH: resolve("missing-strucpp.exe"), STRUCPP_GPP_PATH: process.execPath }, async () => {
      const report = (await toolHandlers.tcgen_st_test_run(loadRequest("adder") as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(report.verdict).toBe("backend_error");
      expect(report.summary.runtimeErrors).toBe(1);
    });
  });

  it("returns failed for assertion failures", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    const request = loadRequest("adder");
    request.testSpec.tests[0].steps = [
      { kind: "call", arguments: { A: 2, B: 3 } },
      { kind: "expectEquals", path: "$target.Sum", value: 6 }
    ];
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(report.verdict).toBe("failed");
      expect(report.summary.failed).toBe(1);
    });
  }, 30_000);

  it("returns compile_error for ST syntax failures", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    const request = loadRequest("adder");
    request.sources[0].content = [
      "FUNCTION_BLOCK FB_Adder",
      "VAR_INPUT",
      "    A : DINT;",
      "    B : DINT;",
      "END_VAR",
      "VAR_OUTPUT",
      "    Sum : DINT;",
      "END_VAR",
      "Sum := ;",
      "END_FUNCTION_BLOCK"
    ].join("\n");
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(report.verdict).toBe("compile_error");
      expect(report.summary.compileErrors).toBe(1);
      const promoted = report.diagnostics.filter(item => item.code.startsWith("STRUCPP_COMPILE_"));
      expect(promoted.length).toBeGreaterThan(0);
      expect(promoted.map(item => item.message).join("\n")).not.toMatch(/[A-Za-z]:[\\/][^\r\n]*tcgen-st-test-/i);
    });
  }, 30_000);

  it("fails closed when an exit-0 backend reports no executed tests", async () => {
    const gppExecutable = process.env.STRUCPP_GPP_PATH ?? "C:\\msys64\\ucrt64\\bin\\g++.exe";
    if (!existsSync(gppExecutable)) return;
    const tempDir = await mkdtemp(join(tmpdir(), "tcgen-no-tests-"));
    const fakeCli = join(tempDir, "fake-strucpp.mjs");
    await writeFile(
      fakeCli,
      [
        "if (process.argv.includes('--version')) {",
        "  console.log('STruC++ version 0.5.12');",
        "  process.exit(0);",
        "}",
        "console.log('Compilation completed without executing tests.');",
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );
    try {
      await withEnv({ STRUCPP_PATH: fakeCli, STRUCPP_GPP_PATH: gppExecutable }, async () => {
        const report = (await toolHandlers.tcgen_st_test_run(
          loadRequest("adder") as unknown as Record<string, unknown>
        )) as SemanticTestReport;
        expect(report.verdict).toBe("backend_error");
        expect(report.tests).toEqual([]);
        expect(report.summary.runtimeErrors).toBe(1);
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "STRUCPP_NO_TEST_RESULTS" }));
        expect(report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "STRUCPP_RUNTIME_STDOUT",
            message: expect.stringContaining("Compilation completed without executing tests.")
          })
        );
      });
    } finally {
      await rmRetry(tempDir);
    }
  }, 30_000);

  it("returns timeout when STruC++ hangs", async () => {
    const gppExecutable = process.env.STRUCPP_GPP_PATH ?? "C:\\msys64\\ucrt64\\bin\\g++.exe";
    if (!existsSync(gppExecutable)) return;
    const tempDir = await mkdtemp(join(tmpdir(), "tcgen-fake-strucpp-"));
    const fakeCli = join(tempDir, "fake-strucpp.mjs");
    await writeFile(
      fakeCli,
      [
        "if (process.argv.includes('--version')) {",
        "  console.log('STruC++ version 0.5.12');",
        "  process.exit(0);",
        "}",
        "setInterval(() => {}, 1000);"
      ].join("\n"),
      "utf8"
    );
    try {
      await withEnv({ STRUCPP_PATH: fakeCli, STRUCPP_GPP_PATH: gppExecutable }, async () => {
        const request = loadRequest("adder");
        request.options = { ...request.options, timeoutMs: 1000 };
        const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
        expect(report.verdict).toBe("timeout");
        expect(report.summary.timedOut).toBe(1);
        expect(report.summary.total).toBe(1);
        expect(report.diagnostics.map(item => item.code)).toContain("SANDBOX_TIMEOUT");
      });
    } finally {
      await rmRetry(tempDir);
    }
  }, 10_000);

  it("does not return retained workspace paths unless explicitly enabled", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    const request = loadRequest("adder");
    request.options = { ...request.options, includeArtifacts: true, keepWorkspace: true };
    await withEnv({ STRUCPP_PATH: repo, TCGEN_ST_ALLOW_KEEP_WORKSPACE: undefined }, async () => {
      const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(report.verdict).toBe("passed");
      expect(report.artifacts?.workspace).toBeUndefined();
      expect(report.diagnostics.map(item => item.code)).toContain("SANDBOX_KEEP_WORKSPACE_DISABLED");
    });
  }, 30_000);

  it("returns failed when a framework test catches a broken CUT", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    const request = loadTestFixture("framework-limit-counter-broken.json");
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(report.verdict).toBe("failed");
      expect(report.summary.failed).toBe(1);
      expect(report.tests[0]?.message ?? "").toContain("counter should clamp at limit");
    });
  }, 60_000);

  it("fails framework tests that complete without production assertions", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st");
    if (!testSource) throw new Error("framework fixture is missing test.st");
    testSource.content = testSource.content
      .split("\n")
      .filter(line => !line.includes("m_xAssertEqualDint("))
      .join("\n");

    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(report.verdict).toBe("failed");
      expect(report.summary.failed).toBe(1);
      expect(report.tests[0]?.message ?? "").toContain("ASSERT_TRUE failed");
    });
  }, 60_000);

  it("blocks a run whose scope excludes the candidate PROGRAM MAIN", async () => {
    const request = loadRequest("framework-production-main");
    request.scope = { mode: "entrypoints", entrypoints: ["FB_Test_ProductionMain"] };
    const report = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;
    expect(report.verdict).toBe("unsupported");
    expect(report.summary.unsupported).toBe(1);
    expect(report.summary.total).toBeGreaterThanOrEqual(1);
    expect(report.diagnostics.map(item => item.code)).toContain("TCSUBJECT_CANDIDATE_SCOPE_EXCLUDED");
    expect(report.normalization.includedObjects).not.toContain("MAIN");
    expect(report.subject.discoveredFrameworkTests).toEqual(["FB_Test_ProductionMain"]);
    expect(report.subject.selectedFrameworkTests).toEqual(["FB_Test_ProductionMain"]);
  });

});

async function rmRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
