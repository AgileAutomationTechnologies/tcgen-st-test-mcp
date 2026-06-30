import { describe, expect, it } from "vitest";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("framework-style semantic tests", () => {
  it("generates an offline framework shim and wrapper test", async () => {
    const result = (await toolHandlers.tcgen_st_test_generate(loadRequest("framework-limit-counter") as unknown as Record<string, unknown>)) as {
      normalization: { status: string; diagnostics: Array<{ code: string }> };
      normalizedFiles: Array<{ path: string; content: string }>;
      testFile: { path: string; content: string };
      generatedTestFile: { path: string; content: string };
      diagnostics: Array<{ code: string }>;
    };

    expect(result.normalization.status).toBe("rewritten");
    expect(result.normalizedFiles[0].path).toBe("tcgen_framework_shim.st");
    expect(result.normalizedFiles[0].content).toContain("FUNCTION_BLOCK FB_TestCaseBase");
    expect(result.testFile.path).toBe("semantic_framework_tests.st");
    expect(result.generatedTestFile).toEqual(result.testFile);
    expect(result.testFile.content).toContain("TEST 'framework FB_Test_LimitCounter'");
    expect(result.testFile.content).toContain("FOR scan := 1 TO 20 DO");
    expect(result.testFile.content).toContain("m_xExecute(i_xTrigger := TRUE)");
    expect(result.testFile.content).toContain("ASSERT_EQ(result.sErrorMessage, '');");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_CORE_REPLACED");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCFRAMEWORK_MAIN_OMITTED");
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
});
