import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { structuredCompilerOutputDiagnostics } from "../src/domain/reportSanitizer.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { TcGenToStrucppNormalizer } from "../src/normalizer/TcGenToStrucppNormalizer.js";
import { normalizerOptionsForTestRequest } from "../src/testspec/TestFileResolver.js";
import { loadRequest } from "./helpers.js";

describe("Framework multi-scan execution contract", () => {
  it("rejects missing and unsupported execution contracts", async () => {
    const missing = loadRequest("framework-limit-counter");
    delete (missing.frameworkTest as unknown as { executionContract?: string }).executionContract;
    const missingResult = await generate(missing);
    expect(codes(missingResult)).toContain("TCFRAMEWORK_EXECUTION_CONTRACT_REQUIRED");
    expect(missingResult.generatedTestFile.content).toBe("");

    const unsupported = loadRequest("framework-limit-counter");
    (unsupported.frameworkTest as unknown as { executionContract: string }).executionContract = "legacy-poll-v0";
    const unsupportedResult = await generate(unsupported);
    expect(codes(unsupportedResult)).toContain("TCFRAMEWORK_EXECUTION_CONTRACT_UNSUPPORTED");
    expect(unsupportedResult.generatedTestFile.content).toBe("");
  });

  it("rejects anonymous inline enum state in exact Framework ST", async () => {
    const request = loadRequest("framework-limit-counter");
    const source = frameworkSource(request);
    source.content = source.content.replace(
      "    nScan : DINT;",
      "    nScan : DINT;\n    eStep : (eInit, eRunning, eDone) := eInit;"
    );
    request.frameworkTest!.targetMappings[0].testSourceSha256 = sha256(source.content);

    const result = await generate(request);

    expect(codes(result)).toContain("TCFRAMEWORK_ANONYMOUS_ENUM_UNSUPPORTED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("rejects a busy test that advances only as a side effect of m_xIsBusy", async () => {
    const request = loadRequest("framework-limit-counter");
    const source = frameworkSource(request);
    source.content = [
      "FUNCTION_BLOCK FB_Test_LimitCounter EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_LimitCounter;",
      "END_VAR",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    fbCut(i_xReset := TRUE, i_xEnable := FALSE, i_nLimit := 3);",
      "    m_xAssertEqualDint(0, fbCut.q_nCount, 'reset output');",
      "    _eExecuteState := eTestState_Running;",
      "    _xPhaseBusy := TRUE;",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "METHOD PUBLIC m_xIsBusy : BOOL",
      "IF _xPhaseBusy THEN",
      "    _eExecuteState := eTestState_Passed;",
      "    _xPhaseBusy := FALSE;",
      "END_IF",
      "m_xIsBusy := _xPhaseBusy;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings[0].testSourceSha256 = sha256(source.content);

    const result = await generate(request);

    expect(codes(result)).toContain("TCFRAMEWORK_MULTISCAN_RESUME_REQUIRED");
    expect(codes(result)).toContain("TCFRAMEWORK_MULTISCAN_TERMINATION_REQUIRED");
    expect(codes(result)).toContain("TCFRAMEWORK_BUSY_OBSERVER_SIDE_EFFECT");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("rejects execute methods that omit the trigger input even when they are synchronous", async () => {
    const request = loadRequest("framework-production-main");
    const source = frameworkSource(request);
    source.content = source.content
      .replace("VAR_INPUT\n    i_xTrigger : BOOL;\nEND_VAR\nIF i_xTrigger THEN\n", "")
      .replace("\nEND_IF\nm_xExecute := TRUE;", "\nm_xExecute := TRUE;");
    request.frameworkTest!.targetMappings[0].testSourceSha256 = sha256(source.content);

    const result = await generate(request);

    expect(codes(result)).toContain("TCFRAMEWORK_EXECUTE_TRIGGER_INPUT_REQUIRED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("rejects unreachable and no-op FALSE-trigger resume paths", async () => {
    const request = loadRequest("framework-limit-counter");
    const source = frameworkSource(request);
    source.content = source.content
      .replace(
        "ELSIF _xPhaseBusy THEN",
        "ELSE\n    nScan := nScan;\n    IF FALSE THEN"
      )
      .replace("END_IF\nm_xExecute := TRUE;", "END_IF\nEND_IF\nm_xExecute := TRUE;");
    request.frameworkTest!.targetMappings[0].testSourceSha256 = sha256(source.content);

    const result = await generate(request);

    expect(codes(result)).toContain("TCFRAMEWORK_MULTISCAN_RESUME_REQUIRED");
    expect(codes(result)).toContain("TCFRAMEWORK_MULTISCAN_TERMINATION_REQUIRED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("keeps a synchronous trigger branch valid when it clears transient busy state before returning", async () => {
    const request = loadRequest("framework-production-main");
    const source = frameworkSource(request);
    source.content = source.content
      .replace(
        "    _eExecuteState := eTestState_Running;",
        "    _eExecuteState := eTestState_Running;\n    _xPhaseBusy := TRUE;"
      )
      .replace(
        "    _eExecuteState := eTestState_Passed;",
        "    _eExecuteState := eTestState_Passed;\n    _xPhaseBusy := FALSE;"
      );
    request.frameworkTest!.targetMappings[0].testSourceSha256 = sha256(source.content);

    const result = await generate(request);

    expect(codes(result)).not.toContain("TCFRAMEWORK_MULTISCAN_RESUME_REQUIRED");
    expect(codes(result)).not.toContain("TCFRAMEWORK_MULTISCAN_TERMINATION_REQUIRED");
    expect(result.generatedTestFile.content.length).toBeGreaterThan(0);
  });

  it("publishes a structured harness diagnostic when execute never completes", async () => {
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue({
      status: "failed",
      executionAttempted: true,
      executable: "strucpp-win.exe",
      cliMode: "native",
      version: "STruC++ version 0.5.13-tcgen.2",
      stdout: "ASSERT_TRUE failed: tcframework_execute_complete expected TRUE, got FALSE\nFAIL: framework FB_Test_LimitCounter",
      stderr: "",
      exitCode: 1,
      durationMs: 1,
      diagnostics: [],
      tests: [{
        name: "framework FB_Test_LimitCounter",
        status: "failed",
        message: "ASSERT_TRUE failed: tcframework_execute_complete expected TRUE, got FALSE"
      }]
    });
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as {
        backend: { executionAttempted: boolean };
        diagnostics: Array<{ code: string; sourceKind?: string }>;
      };

      expect(report.backend.executionAttempted).toBe(true);
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "TCFRAMEWORK_EXECUTE_INCOMPLETE",
        sourceKind: "generated_test_harness"
      }));
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "STRUCPP_TEST_STDOUT",
        sourceKind: "generated_test_harness"
      }));
    } finally {
      backend.mockRestore();
    }
  });

  it("maps normalized compiler line diagnostics back to candidate or Framework source", () => {
    const request = loadRequest("framework-limit-counter");
    const normalized = new TcGenToStrucppNormalizer().normalize(
      request,
      normalizerOptionsForTestRequest(request)
    );
    const harness = normalized.sourceMap.find(entry => entry.object === "FB_Test_LimitCounter");
    const candidate = normalized.sourceMap.find(entry => entry.object === "FB_LimitCounter");
    const runner = normalized.sourceMap.find(entry => entry.object === "MAIN");
    expect(harness).toBeDefined();
    expect(candidate).toBeDefined();
    expect(runner?.sourceKind).toBe("generated_test_harness");

    const harnessDiagnostic = structuredCompilerOutputDiagnostics(
      "compile_error",
      { stdout: "", stderr: `normalized.st:${harness!.generatedStartLine}: error: invalid test state` },
      undefined,
      normalized.sourceMap
    )[0];
    const candidateDiagnostic = structuredCompilerOutputDiagnostics(
      "compile_error",
      { stdout: "", stderr: `normalized.st:${candidate!.generatedStartLine}: error: invalid candidate state` },
      undefined,
      normalized.sourceMap
    )[0];
    const mixedDiagnostic = structuredCompilerOutputDiagnostics(
      "compile_error",
      {
        stdout: "",
        stderr: [
          `normalized.st:${harness!.generatedStartLine}: error: invalid test state`,
          `normalized.st:${candidate!.generatedStartLine}: note: candidate declaration`
        ].join("\n")
      },
      undefined,
      normalized.sourceMap
    )[0];

    expect(harnessDiagnostic).toMatchObject({
      sourceKind: "generated_test_harness",
      object: "FB_Test_LimitCounter",
      original: { path: "test.st" }
    });
    expect(candidateDiagnostic).toMatchObject({
      sourceKind: "candidate",
      object: "FB_LimitCounter",
      original: { path: "cut.st" }
    });
    expect(mixedDiagnostic.sourceKind).toBe("mixed");
    expect(structuredCompilerOutputDiagnostics(
      "compile_error",
      { stdout: "", stderr: "tcgen_framework_shim.st:12: error: invalid shim state" }
    )[0].sourceKind).toBe("generated_test_harness");
  });
});

type GenerationResult = {
  diagnostics: Array<{ code: string }>;
  generatedTestFile: { content: string };
};

async function generate(request: ReturnType<typeof loadRequest>): Promise<GenerationResult> {
  return toolHandlers.tcgen_st_test_generate(
    request as unknown as Record<string, unknown>
  ) as Promise<GenerationResult>;
}

function frameworkSource(request: ReturnType<typeof loadRequest>) {
  const source = request.sources.find(item => item.path === "test.st");
  if (!source) throw new Error("Framework source fixture is missing.");
  return source;
}

function codes(result: GenerationResult): string[] {
  return result.diagnostics.map(item => item.code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
