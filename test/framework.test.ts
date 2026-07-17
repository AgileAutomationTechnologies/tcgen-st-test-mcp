import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("framework-style semantic tests", () => {
  it("fails closed when the backend does not execute the exact framework wrapper", async () => {
    const run = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue({
      status: "passed",
      executionAttempted: true,
      executable: "strucpp-win.exe",
      cliMode: "native",
      version: "STruC++ version 0.5.13-tcgen.6",
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
      executionContract?: string;
      assertions: Array<{
        assertionId: string;
        checkpointId?: string;
        checkpointTestName?: string;
        checkpointOrdinal?: number;
      }>;
      assertionLedger: { complete: boolean; expected: number };
    };

    expect(result.normalization.status).toBe("rewritten");
    expect(result.normalizedFiles[0].path).toBe("tcgen_framework_shim.st");
    expect(result.normalizedFiles[0].content).toContain("FUNCTION_BLOCK FB_TestCaseBase");
    expect(result.testFile.path).toBe("test.st");
    expect(result.frameworkTestFiles).toEqual([result.testFile]);
    expect(result.frameworkTestFiles[0].content).toBe(
      loadRequest("framework-limit-counter").sources.find(source => source.path === "test.st")?.content
    );
    expect(result.generatedTestFile.path).toBe("semantic_framework_tests.st");
    expect(result.generatedTestFile).not.toEqual(result.testFile);
    expect(result.generatedTestFile.content).toContain("TEST 'framework FB_Test_LimitCounter'");
    // One parent execution plus one fresh test/CUT execution per assertion.
    expect(result.generatedTestFile.content.match(/ADVANCE_TIME\(1000000\)/g)).toHaveLength(100);
    expect(result.generatedTestFile.content).toContain("m_xExecute(i_xTrigger := TRUE)");
    expect(result.generatedTestFile.content.match(/m_xExecute\(i_xTrigger := TRUE\)/g)).toHaveLength(5);
    expect(result.generatedTestFile.content).toContain("m_xExecute(i_xTrigger := FALSE)");
    expect(result.generatedTestFile.content.match(/m_xExecute\(i_xTrigger := FALSE\)/g)).toHaveLength(100);
    expect(result.generatedTestFile.content).toContain("test_FB_Test_LimitCounter_checkpoint_1");
    expect(result.generatedTestFile.content).toContain("test_FB_Test_LimitCounter_checkpoint_4");
    expect(result.generatedTestFile.content.indexOf("ADVANCE_TIME(1000000)"))
      .toBeLessThan(result.generatedTestFile.content.indexOf("m_xExecute(i_xTrigger := FALSE)"));
    expect(result.generatedTestFile.content.indexOf("m_xExecute(i_xTrigger := FALSE)"))
      .toBeLessThan(result.generatedTestFile.content.indexOf("m_xIsBusy()", result.generatedTestFile.content.indexOf("ADVANCE_TIME")));
    expect(result.generatedTestFile.content).toContain("ASSERT_TRUE(tcframework_execute_complete);");
    expect(result.generatedTestFile.content).toContain("ASSERT_EQ(result.eState, eTestState_Passed);");
    expect(result.generatedTestFile.content).toContain("ASSERT_EQ(result.eExecuteState, eTestState_Passed);");
    expect(result.generatedTestFile.content).toContain("ASSERT_TRUE(result.udiAssertions > 0);");
    expect(result.generatedTestFile.content).toContain("ASSERT_EQ(result.udiFailed, 0);");
    expect(result.generatedTestFile.content).toContain("ASSERT_EQ(result.udiPassed, result.udiAssertions);");
    expect(result.executionContract).toBe("tcgen-framework-multiscan-v1");
    expect(result.generatedTestFile.content).toContain("TcGenAssertionLedgerReached(");
    expect(result.generatedTestFile.content).toContain("TcGenAssertionLedgerPassed(");
    expect(result.generatedTestFile.content).not.toContain("ASSERT_EQ(result.sErrorMessage, '');");
    expect(result.assertions).toHaveLength(4);
    expect(result.assertions.every(assertion =>
      /^checkpoint:[a-f0-9]{64}$/.test(assertion.checkpointId ?? "")
      && /^framework checkpoint FB_Test_LimitCounter [a-f0-9]{64}$/.test(assertion.checkpointTestName ?? "")
      && Number.isInteger(assertion.checkpointOrdinal)
    )).toBe(true);
    expect(result.normalizedFiles[0].content).toContain("GVL_TcGenAssertionLedger__aAssertionId");
    expect(result.normalizedFiles[0].content).toContain(result.assertions[0].assertionId);
    expect(result.generatedTestFile.content).toContain(
      `TcGenAssertionLedgerReached('${result.assertions[0].assertionId}')`
    );
    expect(result.assertionLedger).toMatchObject({ complete: false, expected: 4 });
    expect(result.frameworkTargetCoverage).toEqual([
      {
        testFunctionBlock: "FB_Test_LimitCounter",
        productionTarget: "FB_LimitCounter",
        testSourcePath: "test.st",
        testSourceSha256: sha256(result.testFile.content),
        assertionCount: 4,
        targetReferenceCount: 9,
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

  it("keeps Framework ST portable while isolating project dependencies in the adapter", async () => {
    const request = loadRequest("framework-limit-counter");
    const dependency = {
      path: "project/ReadSensor.st",
      content: [
        "FUNCTION ReadSensor : DINT",
        "ReadSensor := 99;",
        "END_FUNCTION"
      ].join("\n")
    };
    request.sources.push(dependency);
    request.scope = { mode: "all" };
    request.projectDependencySourceSha256 = [{
      path: dependency.path,
      sourceSha256: createHash("sha256").update(dependency.content, "utf8").digest("hex")
    }];
    request.dependencySimulations = [{
      frameworkTest: "FB_Test_LimitCounter",
      kind: "function",
      functionName: "ReadSensor",
      returnValue: { type: "DINT", value: 7 }
    }];

    const result = (await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    )) as {
      normalizedFiles: Array<{ content: string }>;
      generatedTestFile: { content: string };
      frameworkTestFiles: Array<{ content: string }>;
      dependencySimulations: unknown[];
    };

    const normalized = result.normalizedFiles.map(file => file.content).join("\n");
    expect(normalized).toContain("FUNCTION ReadSensor : DINT");
    expect(normalized).not.toContain("ReadSensor := 99;");
    expect(result.generatedTestFile.content).toContain("MOCK_FUNCTION ReadSensor RETURNS 7;");
    expect(result.frameworkTestFiles[0].content).not.toContain("MOCK_FUNCTION");
    expect(result.frameworkTestFiles[0].content).toBe(
      request.sources.find(source => source.path === "test.st")?.content
    );
    expect(result.dependencySimulations).toEqual(request.dependencySimulations);
  });

  it("stubs project FB bodies and applies fixed outputs only in the offline adapter", async () => {
    const request = loadRequest("framework-limit-counter");
    const candidate = request.sources.find(source => source.path === request.candidateSourcePath)!;
    candidate.content = [
      "FUNCTION_BLOCK FB_LimitCounter",
      "VAR_OUTPUT",
      "    q_nCount : DINT;",
      "END_VAR",
      "VAR",
      "    fbDependency : FB_Dependency;",
      "END_VAR",
      "fbDependency();",
      "q_nCount := fbDependency.q_nValue;",
      "END_FUNCTION_BLOCK"
    ].join("\n");
    const dependency = {
      path: "project/FB_Dependency.st",
      content: [
        "FUNCTION_BLOCK FB_Dependency",
        "VAR_OUTPUT",
        "    q_nValue : DINT;",
        "END_VAR",
        "q_nValue := 99;",
        "END_FUNCTION_BLOCK"
      ].join("\n")
    };
    request.sources.push(dependency);
    request.projectDependencySourceSha256 = [{
      path: dependency.path,
      sourceSha256: createHash("sha256").update(dependency.content, "utf8").digest("hex")
    }];
    request.dependencySimulations = [{
      frameworkTest: "FB_Test_LimitCounter",
      kind: "function_block",
      instancePath: "fbCut.fbDependency",
      outputs: [{ member: "q_nValue", type: "DINT", value: 7 }]
    }];

    const result = (await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    )) as {
      normalizedFiles: Array<{ path: string; content: string }>;
      generatedTestFile: { content: string };
      frameworkTestFiles: Array<{ content: string }>;
    };

    const dependencyOutput = result.normalizedFiles.map(file => file.content).join("\n");
    expect(dependencyOutput).toContain("FUNCTION_BLOCK FB_Dependency");
    expect(dependencyOutput).toContain("q_nValue");
    expect(dependencyOutput).not.toContain("q_nValue := 99;");
    expect(result.generatedTestFile.content).toContain("MOCK test_FB_Test_LimitCounter_capture.fbCut.fbDependency;");
    expect(result.generatedTestFile.content).toContain("fbCut.fbDependency.q_nValue := 7;");
    expect(result.frameworkTestFiles[0].content).not.toContain("MOCK ");
  });

  it("never stubs the exact candidate even if an untrusted request lists its path", async () => {
    const request = loadRequest("framework-limit-counter");
    const candidate = request.sources.find(source => source.path === request.candidateSourcePath)!;
    request.projectDependencySourceSha256 = [{
      path: candidate.path,
      sourceSha256: createHash("sha256").update(candidate.content, "utf8").digest("hex")
    }];

    const result = (await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    )) as { normalizedFiles: Array<{ content: string }> };

    expect(result.normalizedFiles.map(file => file.content).join("\n"))
      .toContain("q_nCount := q_nCount + 1;");
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
    conflict.frameworkTest = {
      mode: "tcgen-test-framework",
      executionContract: "tcgen-framework-multiscan-v1",
      targetMappings: []
    };
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
      executionContract: "tcgen-framework-multiscan-v1",
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
