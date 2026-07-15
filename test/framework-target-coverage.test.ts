import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

type FrameworkGenerationResult = {
  generatedTestFile: { path: string; content: string };
  testFile: { path: string; content: string };
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
  diagnostics: Array<{ code: string; message: string }>;
};

describe("trusted framework target coverage", () => {
  it("requires exact target mappings before generating an execution adapter", async () => {
    const request = loadRequest("framework-limit-counter");
    delete (request.frameworkTest as { targetMappings?: unknown }).targetMappings;

    const result = await generate(request);

    expect(result.generatedTestFile.content).toBe("");
    expect(result.testFile.path).toBe("test.st");
    expect(result.frameworkTestFiles).toEqual([result.testFile]);
    expect(result.frameworkTargetCoverage).toEqual([]);
    expect(codes(result)).toContain("TCFRAMEWORK_TARGET_MAPPINGS_REQUIRED");
  });

  it("rejects a mismatched framework source hash while preserving the submitted source", async () => {
    const request = loadRequest("framework-limit-counter");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = "0".repeat(64);

    const result = await generate(request);

    expect(result.generatedTestFile.content).toBe("");
    expect(result.testFile.content).toBe(request.sources.find(source => source.path === "test.st")!.content);
    expect(result.frameworkTargetCoverage[0]).toMatchObject({
      testFunctionBlock: "FB_Test_LimitCounter",
      productionTarget: "FB_LimitCounter",
      verified: false
    });
    expect(codes(result)).toContain("TCFRAMEWORK_TEST_SOURCE_HASH_MISMATCH");
  });

  it("does not accept production names in strings or literal-only assertions as coverage", async () => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st")!;
    testSource.content = [
      "FUNCTION_BLOCK FB_Test_LimitCounter EXTENDS FB_TestCaseBase",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    _sTestCaseName := 'FB_LimitCounter is mentioned only in a string';",
      "    m_xAssertTrue(TRUE, 'FB_LimitCounter literal smoke assertion');",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = sha256(testSource.content);

    const result = await generate(request);

    expect(result.frameworkTargetCoverage[0]).toMatchObject({
      assertionCount: 1,
      targetReferenceCount: 0,
      verified: false
    });
    expect(codes(result)).toContain("TCFRAMEWORK_PRODUCTION_TARGET_NOT_REFERENCED");
    expect(codes(result)).toContain("TCFRAMEWORK_MEANINGFUL_ASSERTION_REQUIRED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("does not treat IEC operators or typed literals as observed assertion values", async () => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st")!;
    testSource.content = [
      "FUNCTION_BLOCK FB_Test_LimitCounter EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_LimitCounter;",
      "END_VAR",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    m_xAssertTrue(NOT FALSE AND_THEN TRUE, 'literal boolean expression');",
      "    m_xAssertEqualDint(DINT#1, DINT#1, 'equal typed literals');",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = sha256(testSource.content);

    const result = await generate(request);

    expect(result.frameworkTargetCoverage[0]).toMatchObject({
      assertionCount: 2,
      targetReferenceCount: 0,
      verified: false
    });
    expect(codes(result)).toContain("TCFRAMEWORK_PRODUCTION_TARGET_NOT_REFERENCED");
    expect(codes(result)).toContain("TCFRAMEWORK_MEANINGFUL_ASSERTION_REQUIRED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("does not treat a target instance declaration without executable use as coverage", async () => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st")!;
    testSource.content = [
      "FUNCTION_BLOCK FB_Test_LimitCounter EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_LimitCounter;",
      "    observed : DINT;",
      "END_VAR",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    observed := observed + 1;",
      "    m_xAssertEqualDint(1, observed, 'unrelated observed state');",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = sha256(testSource.content);

    const result = await generate(request);

    expect(result.frameworkTargetCoverage[0]).toMatchObject({
      assertionCount: 1,
      targetReferenceCount: 0,
      verified: false
    });
    expect(codes(result)).toContain("TCFRAMEWORK_PRODUCTION_TARGET_NOT_REFERENCED");
    expect(codes(result)).not.toContain("TCFRAMEWORK_MEANINGFUL_ASSERTION_REQUIRED");
  });

  it("rejects an unrelated local assertion even when the mapped target is invoked", async () => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st")!;
    testSource.content = [
      "FUNCTION_BLOCK FB_Test_LimitCounter EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_LimitCounter;",
      "    nObserved : DINT;",
      "END_VAR",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    fbCut(i_xReset := TRUE, i_xEnable := FALSE, i_nLimit := 3);",
      "    nObserved := nObserved + 1;",
      "    m_xAssertEqualDint(1, nObserved, 'unrelated local state');",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = sha256(testSource.content);

    const result = await generate(request);

    expect(result.frameworkTargetCoverage[0]).toMatchObject({
      assertionCount: 1,
      verified: false
    });
    expect(result.frameworkTargetCoverage[0].targetReferenceCount).toBeGreaterThan(0);
    expect(codes(result)).toContain("TCFRAMEWORK_TARGET_LINKED_ASSERTION_REQUIRED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("accepts assertions over direct target output and a derived local value", async () => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st")!;
    testSource.content = [
      "FUNCTION_BLOCK FB_Test_LimitCounter EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_LimitCounter;",
      "    nObserved : DINT;",
      "    nDerived : DINT;",
      "END_VAR",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    fbCut(i_xReset := TRUE, i_xEnable := FALSE, i_nLimit := 3);",
      "    m_xAssertEqualDint(0, fbCut.q_nCount, 'direct target output');",
      "    nObserved := fbCut.q_nCount;",
      "    nDerived := nObserved + 1;",
      "    m_xAssertEqualDint(1, nDerived, 'derived target output');",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = sha256(testSource.content);

    const result = await generate(request);

    expect(result.frameworkTargetCoverage[0]).toMatchObject({
      assertionCount: 2,
      verified: true
    });
    expect(codes(result)).not.toContain("TCFRAMEWORK_TARGET_LINKED_ASSERTION_REQUIRED");
    expect(result.generatedTestFile.content).not.toBe("");
  });

  it.each([
    "m_xAssertEqualDint(fbCut.q_nCount, fbCut.q_nCount, 'self equality');",
    "m_xAssertTrue(fbCut.q_nCount = fbCut.q_nCount, 'self comparison');"
  ])("rejects target-linked tautology: %s", async assertion => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(source => source.path === "test.st")!;
    testSource.content = [
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
      `    ${assertion}`,
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    request.frameworkTest!.targetMappings![0].testSourceSha256 = sha256(testSource.content);

    const result = await generate(request);

    expect(result.frameworkTargetCoverage[0].verified).toBe(false);
    expect(codes(result)).toContain("TCFRAMEWORK_TARGET_LINKED_ASSERTION_REQUIRED");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("requires complete one-to-one coverage of every executable candidate object", async () => {
    const request = loadRequest("framework-limit-counter");
    const candidate = request.sources.find(source => source.path === "cut.st")!;
    candidate.content += [
      "",
      "FUNCTION_BLOCK FB_Uncovered",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");

    const result = await generate(request);

    expect(codes(result)).toContain("TCFRAMEWORK_PRODUCTION_COVERAGE_INCOMPLETE");
    expect(result.diagnostics.find(item => item.code === "TCFRAMEWORK_PRODUCTION_COVERAGE_INCOMPLETE")?.message)
      .toContain("FB_Uncovered");
    expect(result.generatedTestFile.content).toBe("");
  });

  it("does not require a framework runner registration PROGRAM as a production target", async () => {
    const request = loadRequest("framework-limit-counter");
    request.candidateSourcePath = "main.st";

    const result = await generate(request);

    expect(codes(result)).toContain("TCFRAMEWORK_PRODUCTION_TARGET_NOT_CANDIDATE");
    expect(codes(result)).not.toContain("TCFRAMEWORK_PRODUCTION_COVERAGE_INCOMPLETE");
    expect(result.diagnostics.map(item => item.message).join("\n")).not.toContain("missing or duplicated: MAIN");
  });

  it("verifies several target mappings against one exact aggregate candidate", async () => {
    const request = loadRequest("framework-limit-counter");
    const cut = request.sources.find(source => source.path === "cut.st")!;
    const firstTest = request.sources.find(source => source.path === "test.st")!;
    const runner = request.sources.find(source => source.path === "main.st")!;
    const secondProduction = [
      "FUNCTION_BLOCK FB_EnableLatch",
      "VAR_INPUT",
      "    i_xEnable : BOOL;",
      "END_VAR",
      "VAR_OUTPUT",
      "    q_xLatched : BOOL;",
      "END_VAR",
      "IF i_xEnable THEN",
      "    q_xLatched := TRUE;",
      "END_IF",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    const secondTest = [
      "FUNCTION_BLOCK FB_Test_EnableLatch EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_EnableLatch;",
      "END_VAR",
      "METHOD PUBLIC m_xExecute : BOOL",
      "VAR_INPUT",
      "    i_xTrigger : BOOL;",
      "END_VAR",
      "IF i_xTrigger THEN",
      "    _sTestCaseName := 'FB_EnableLatch latches enable';",
      "    _eExecuteState := eTestState_Running;",
      "    fbCut(i_xEnable := TRUE);",
      "    m_xAssertTrue(fbCut.q_xLatched, 'enable should latch');",
      "    _eExecuteState := eTestState_Passed;",
      "END_IF",
      "m_xExecute := TRUE;",
      "END_METHOD",
      "END_FUNCTION_BLOCK",
      ""
    ].join("\n");
    const aggregate = [cut.content, firstTest.content, secondProduction, secondTest, runner.content].join("\n");
    const aggregatePath = "virtual-tests/tcgen-framework-aggregate.st";
    const aggregateSha256 = sha256(aggregate);
    request.candidateSourcePath = aggregatePath;
    request.sources = [
      request.sources.find(source => source.path === "framework-core.st")!,
      { path: aggregatePath, content: aggregate }
    ];
    request.frameworkTest = {
      mode: "tcgen-test-framework",
      executionContract: "tcgen-framework-multiscan-v1",
      testFunctionBlocks: ["FB_Test_LimitCounter", "FB_Test_EnableLatch"],
      targetMappings: [
        {
          testFunctionBlock: "FB_Test_LimitCounter",
          productionTarget: "FB_LimitCounter",
          testSourcePath: aggregatePath,
          testSourceSha256: aggregateSha256
        },
        {
          testFunctionBlock: "FB_Test_EnableLatch",
          productionTarget: "FB_EnableLatch",
          testSourcePath: aggregatePath,
          testSourceSha256: aggregateSha256
        }
      ],
      maxScans: 20
    };

    const result = await generate(request);

    expect(result.generatedTestFile.content).not.toBe("");
    expect(result.testFile).toEqual({ path: aggregatePath, content: aggregate });
    expect(result.frameworkTestFiles).toEqual([{ path: aggregatePath, content: aggregate }]);
    expect(result.frameworkTargetCoverage).toEqual([
      expect.objectContaining({
        testFunctionBlock: "FB_Test_LimitCounter",
        productionTarget: "FB_LimitCounter",
        testSourcePath: aggregatePath,
        testSourceSha256: aggregateSha256,
        verified: true
      }),
      expect.objectContaining({
        testFunctionBlock: "FB_Test_EnableLatch",
        productionTarget: "FB_EnableLatch",
        testSourcePath: aggregatePath,
        testSourceSha256: aggregateSha256,
        verified: true
      })
    ]);
    expect(codes(result)).not.toContain("TCFRAMEWORK_PRODUCTION_COVERAGE_INCOMPLETE");
  });
});

async function generate(request: ReturnType<typeof loadRequest>): Promise<FrameworkGenerationResult> {
  return toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>) as Promise<FrameworkGenerationResult>;
}

function codes(result: FrameworkGenerationResult): string[] {
  return result.diagnostics.map(item => item.code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
