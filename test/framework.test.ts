import { describe, expect, it } from "vitest";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("framework-style semantic tests", () => {
  it("generates an offline framework shim and wrapper test", async () => {
    const result = (await toolHandlers.tcgen_st_test_generate(loadRequest("framework-limit-counter") as unknown as Record<string, unknown>)) as {
      normalization: { status: string; includedObjects: string[]; omittedObjects: string[]; diagnostics: Array<{ code: string }> };
      normalizedFiles: Array<{ path: string; content: string }>;
      testFile: { path: string; content: string };
      generatedTestFile: { path: string; content: string };
      diagnostics: Array<{ code: string }>;
      subject: { discoveredFrameworkTests?: string[]; selectedFrameworkTests?: string[] };
    };

    expect(result.normalization.status).toBe("rewritten");
    expect(result.normalizedFiles[0].path).toBe("tcgen_framework_shim.st");
    expect(result.normalizedFiles[0].content).toContain("FUNCTION_BLOCK FB_TestCaseBase");
    expect(result.testFile.path).toBe("semantic_framework_tests.st");
    expect(result.generatedTestFile).toEqual(result.testFile);
    expect(result.testFile.content).toContain("TEST 'framework FB_Test_LimitCounter'");
    expect(result.testFile.content).toContain("FOR scan := 1 TO 20 DO");
    expect(result.testFile.content).toContain("m_xExecute(i_xTrigger := TRUE)");
    expect(result.testFile.content.match(/m_xExecute\(i_xTrigger := TRUE\)/g)).toHaveLength(1);
    expect(result.testFile.content).toContain("ASSERT_EQ(result.sErrorMessage, '');");
    expect(result.testFile.content).toContain("ASSERT_TRUE(result.udiAssertions > 0);");
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
    request.frameworkTest = { mode: "tcgen-test-framework" };
    const result = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      testFile: { content: string };
      diagnostics: Array<{ code: string }>;
    };

    expect(result.diagnostics.some(item => item.code === "TCFRAMEWORK_TESTS_NOT_FOUND")).toBe(false);
    expect(result.testFile.content).toContain("framework FB_Test_LimitCounter");
  });

  it("rejects conflicting and missing test authorities", async () => {
    const conflict = loadRequest("adder");
    conflict.frameworkTest = { mode: "tcgen-test-framework" };
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
      content: originalTest.content.replaceAll("FB_Test_LimitCounter", "FB_Test_Other")
    });

    const incomplete = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      subject: { discoveredFrameworkTests?: string[]; selectedFrameworkTests?: string[] };
      testFile: { content: string };
      diagnostics: Array<{ code: string }>;
    };
    expect(incomplete.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_TEST_SELECTION_INCOMPLETE");
    expect(incomplete.subject.discoveredFrameworkTests).toEqual(["FB_Test_LimitCounter", "FB_Test_Other"]);
    expect(incomplete.subject.selectedFrameworkTests).toEqual(["FB_Test_LimitCounter"]);
    expect(incomplete.testFile.content).toBe("");

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
      testFunctionBlocks: ["FB_Test_LimitCounter", "FB_Test_Other"]
    };
    const complete = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as {
      testFile: { content: string };
      diagnostics: Array<{ code: string }>;
    };
    expect(complete.diagnostics.map(item => item.code)).not.toContain("TCFRAMEWORK_TEST_SELECTION_INCOMPLETE");
    expect(complete.testFile.content).toContain("framework FB_Test_LimitCounter");
    expect(complete.testFile.content).toContain("framework FB_Test_Other");
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
