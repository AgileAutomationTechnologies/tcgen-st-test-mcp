import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("framework-style semantic tests", () => {
  it("fails closed when the backend does not execute the exact framework wrapper", async () => {
    const run = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue({
      status: "passed",
      executable: "strucpp-win.exe",
      cliMode: "native",
      version: "STruC++ version 0.5.12",
      stdout: "PASS: stale framework test",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      diagnostics: [],
      tests: [{ name: "stale framework test", status: "passed" }]
    });
    try {
      const report = (await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      )) as {
        verdict: string;
        diagnostics: Array<{ code: string }>;
      };

      expect(report.verdict).toBe("backend_error");
      expect(report.diagnostics.map(item => item.code)).toContain("STRUCPP_INCOMPLETE_TEST_RESULTS");
    } finally {
      run.mockRestore();
    }
  });

  it("generates an offline framework shim and wrapper test", async () => {
    const result = (await toolHandlers.tcgen_st_test_generate(loadRequest("framework-limit-counter") as unknown as Record<string, unknown>)) as {
      normalization: { status: string; includedObjects: string[]; omittedObjects: string[]; diagnostics: Array<{ code: string }> };
      normalizedFiles: Array<{ path: string; content: string }>;
      testFile: { path: string; content: string };
      generatedTestFile: { path: string; content: string };
      frameworkTestFiles: Array<{ path: string; content: string }>;
      frameworkTargetCoverage: Array<{
        testFunctionBlock: string;
        productionTarget: string;
        testSourcePath: string;
        testSourceSha256: string;
        assertionCount: number;
        targetReferenceCount: number;
        verified: boolean;
      }>;
      diagnostics: Array<{ code: string }>;
      subject: { discoveredFrameworkTests?: string[]; selectedFrameworkTests?: string[] };
    };

    expect(result.normalization.status).toBe("rewritten");
    expect(result.normalizedFiles[0].path).toBe("tcgen_framework_shim.st");
    expect(result.normalizedFiles[0].content).toContain("FUNCTION_BLOCK FB_TestCaseBase");
    expect(result.testFile.path).toBe("test.st");
    expect(result.frameworkTestFiles).toEqual([result.testFile]);
    expect(result.generatedTestFile.path).toBe("semantic_framework_tests.st");
    expect(result.generatedTestFile).not.toEqual(result.testFile);
    expect(result.generatedTestFile.content).toContain("TEST 'framework FB_Test_LimitCounter'");
    expect(result.generatedTestFile.content).toContain("FOR scan := 1 TO 20 DO");
    expect(result.generatedTestFile.content).toContain("m_xExecute(i_xTrigger := TRUE)");
    expect(result.generatedTestFile.content.match(/m_xExecute\(i_xTrigger := TRUE\)/g)).toHaveLength(1);
    expect(result.generatedTestFile.content).toContain("ASSERT_EQ(result.sErrorMessage, '');");
    expect(result.generatedTestFile.content).toContain("ASSERT_TRUE(result.udiAssertions > 0);");
    expect(result.frameworkTargetCoverage).toEqual([
      {
        testFunctionBlock: "FB_Test_LimitCounter",
        productionTarget: "FB_LimitCounter",
        testSourcePath: "test.st",
        testSourceSha256: sha256(result.testFile.content),
        assertionCount: 4,
        targetReferenceCount: 7,
        verified: true
      }
    ]);
    expect(result.subject.selectedFrameworkTests).toEqual(["FB_Test_LimitCounter"]);
    expect(result.subject.discoveredFrameworkTests).toEqual(["FB_Test_LimitCounter"]);
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_CORE_REPLACED");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_RUNNER_PROGRAM_REWRITTEN");
    expect(result.normalization.includedObjects).not.toContain("FB_TestCaseBase");
    expect(result.normalization.includedObjects).toContain("MAIN");
    expect(result.normalization.omittedObjects).toContain("FB_TestCaseBase");
    expect(result.normalization.omittedObjects).not.toContain("MAIN");
    expect(result.normalizedFiles.map(file => file.content).join("\n")).toContain("_tcgenOfflineFrameworkRegistrationValidated");
    expect(result.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_SHIM_APPLIED");
  });

  it("discovers framework tests when none are explicitly selected", async () => {
    const request = loadRequest("framework-limit-counter");
    request.frameworkTest = { ...request.frameworkTest!, mode: "tcgen-test-framework", testFunctionBlocks: undefined };
    const result = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      generatedTestFile: { content: string };
      diagnostics: Array<{ code: string }>;
    };

    expect(result.diagnostics.some(item => item.code === "TCFRAMEWORK_TESTS_NOT_FOUND")).toBe(false);
    expect(result.generatedTestFile.content).toContain("framework FB_Test_LimitCounter");
  });

  it("rejects conflicting and missing test authorities", async () => {
    const conflict = loadRequest("adder");
    conflict.frameworkTest = { mode: "tcgen-test-framework", targetMappings: [] };
    const conflictResult = (await toolHandlers.tcgen_st_test_generate(conflict as unknown as Record<string, unknown>)) as {
      diagnostics: Array<{ code: string }>;
    };
    expect(conflictResult.diagnostics.map(item => item.code)).toContain("TCTEST_INPUT_CONFLICT");

    const missing = loadRequest("adder");
    delete missing.testSpec;
    const missingResult = (await toolHandlers.tcgen_st_test_generate(missing as unknown as Record<string, unknown>)) as {
      diagnostics: Array<{ code: string }>;
    };
    expect(missingResult.diagnostics.map(item => item.code)).toContain("TCTEST_INPUT_REQUIRED");
  });

  it("reports missing requested framework tests", async () => {
    const request = loadRequest("framework-limit-counter");
    request.frameworkTest = {
      ...request.frameworkTest!,
      mode: "tcgen-test-framework",
      testFunctionBlocks: ["FB_Test_Missing"]
    };
    const result = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      diagnostics: Array<{ code: string }>;
    };
    expect(result.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_TEST_NOT_FOUND");
  });

  it("rejects an explicit passing subset of submitted framework tests", async () => {
    const request = loadRequest("framework-limit-counter");
    const originalTest = request.sources.find(source => source.path === "test.st");
    if (!originalTest) throw new Error("framework fixture is missing test.st");
    request.sources.push({
      path: "other-test.st",
      content: originalTest.content
        .replaceAll("FB_Test_LimitCounter", "FB_Test_Other")
        .replaceAll("FB_LimitCounter", "FB_Other")
    });
    const candidate = request.sources.find(source => source.path === "cut.st");
    if (!candidate) throw new Error("framework fixture is missing cut.st");
    candidate.content += "\nFUNCTION_BLOCK FB_Other\nVAR_OUTPUT\n    q_nCount : DINT;\nEND_VAR\nq_nCount := q_nCount + 1;\nEND_FUNCTION_BLOCK\n";

    const incomplete = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      subject: { discoveredFrameworkTests?: string[]; selectedFrameworkTests?: string[] };
      testFile: { content: string };
      generatedTestFile: { content: string };
      diagnostics: Array<{ code: string }>;
    };
    expect(incomplete.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_TEST_SELECTION_INCOMPLETE");
    expect(incomplete.subject.discoveredFrameworkTests).toEqual(["FB_Test_LimitCounter", "FB_Test_Other"]);
    expect(incomplete.subject.selectedFrameworkTests).toEqual(["FB_Test_LimitCounter"]);
    expect(incomplete.testFile.content).toBe(originalTest.content);
    expect(incomplete.generatedTestFile.content).toBe("");

    const blockedRun = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as {
      verdict: string;
      tests: unknown[];
      diagnostics: Array<{ code: string }>;
    };
    expect(blockedRun.verdict).toBe("backend_error");
    expect(blockedRun.tests).toEqual([]);
    expect(blockedRun.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_TEST_SELECTION_INCOMPLETE");

    request.frameworkTest = {
      mode: "tcgen-test-framework",
      testFunctionBlocks: ["FB_Test_LimitCounter", "FB_Test_Other"],
      targetMappings: [
        ...request.frameworkTest!.targetMappings!,
        {
          testFunctionBlock: "FB_Test_Other",
          productionTarget: "FB_Other",
          testSourcePath: "other-test.st",
          testSourceSha256: sha256(request.sources.find(source => source.path === "other-test.st")!.content)
        }
      ]
    };
    const complete = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      generatedTestFile: { content: string };
      diagnostics: Array<{ code: string }>;
    };
    expect(complete.diagnostics.map(item => item.code)).not.toContain("TCFRAMEWORK_TEST_SELECTION_INCOMPLETE");
    expect(complete.generatedTestFile.content).toContain("framework FB_Test_LimitCounter");
    expect(complete.generatedTestFile.content).toContain("framework FB_Test_Other");
  });

  it("keeps a production PROGRAM MAIN in the compiled framework source", async () => {
    const result = (await toolHandlers.tcgen_st_test_generate(
      loadRequest("framework-production-main") as unknown as Record<string, unknown>
    )) as {
      normalization: { includedObjects: string[]; omittedObjects: string[]; diagnostics: Array<{ code: string }> };
      normalizedFiles: Array<{ content: string }>;
    };
    expect(result.normalizedFiles.map(file => file.content).join("\n")).toContain("PROGRAM MAIN");
    expect(result.normalization.includedObjects).toContain("MAIN");
    expect(result.normalization.omittedObjects).not.toContain("MAIN");
    expect(result.normalization.diagnostics.map(item => item.code)).not.toContain("TCFRAMEWORK_RUNNER_PROGRAM_REWRITTEN");
  });

  it("retains a candidate framework runner PROGRAM through a compiled offline surrogate", async () => {
    const request = loadRequest("framework-limit-counter");
    request.candidateSourcePath = "main.st";
    const result = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      normalization: { includedObjects: string[]; omittedObjects: string[]; diagnostics: Array<{ code: string }> };
      normalizedFiles: Array<{ content: string }>;
    };
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_RUNNER_PROGRAM_REWRITTEN");
    expect(result.normalization.includedObjects).toContain("MAIN");
    expect(result.normalization.omittedObjects).not.toContain("MAIN");
    expect(result.normalizedFiles.map(file => file.content).join("\n")).toContain("PROGRAM MAIN");
    expect(result.normalizedFiles.map(file => file.content).join("\n")).toContain("_tcgenOfflineFrameworkRegistrationValidated");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
