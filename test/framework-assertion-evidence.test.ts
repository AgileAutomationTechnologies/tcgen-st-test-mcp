import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { copyStandardFunctionBlockContracts } from "../src/backends/StandardFunctionBlockContracts.js";
import type { FrameworkAssertionEvidence, FrameworkAssertionLedger } from "../src/domain/models.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { validateSemanticReport } from "../src/schemas/validators.js";
import { extractFrameworkAssertionEvidence } from "../src/testspec/FrameworkAssertionEvidence.js";
import { loadRequest, localStrucppRepo, withEnv } from "./helpers.js";

describe("Framework assertion evidence", () => {
  it("binds meaningful submitted assertions to stable source lines and identities", async () => {
    const request = loadRequest("framework-limit-counter");
    const source = request.sources.find(item => item.path === "test.st");
    if (!source) throw new Error("fixture source missing");

    const generated = await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    ) as { assertions: FrameworkAssertionEvidence[] };

    expect(generated.assertions).toHaveLength(4);
    expect(generated.assertions[0]).toMatchObject({
      assertionId: expect.stringMatching(/^assertion:[a-f0-9]{64}$/),
      testFunctionBlock: "FB_Test_LimitCounter",
      productionTarget: "FB_LimitCounter",
      assertionName: "m_xAssertEqualDint",
      sourcePath: "test.st",
      testSourceSha256: sha256(source.content),
      sourceLine: source.content.slice(0, source.content.indexOf("m_xAssertEqualDint"))
        .split(/\r?\n/).length,
      description: "first count should be 1",
      targetLinked: true,
      status: "not_run",
      executionEvidence: "not_executed"
    });
    expect(new Set(generated.assertions.map(item => item.assertionId)).size).toBe(4);
  });

  it("marks every submitted assertion passed when its exact wrapper passes", async () => {
    const generated = await generatedFrameworkContract();
    const progress: Array<{ tcgen?: { phase: string; status: string; ordinal: number } }> = [];
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("passed", generated.generatedTestNames.map(name => ({ name, status: "passed" })))
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>,
        { reportProgress: update => progress.push(update) }
      ) as {
        verdict: string;
        assertions: FrameworkAssertionEvidence[];
        assertionLedger: FrameworkAssertionLedger;
      };

      expect(report.verdict).toBe("passed");
      expect(report.assertions).toHaveLength(4);
      expect(report.assertions.every(item => item.status === "passed")).toBe(true);
      expect(report.assertions.every(item => item.reached)).toBe(true);
      expect(report.assertions.every(item => item.startedAt && item.completedAt)).toBe(true);
      expect(report.assertions.every(item => item.executionEvidence === "assertion_checkpoint_passed")).toBe(true);
      expect(report.assertionLedger).toMatchObject({
        complete: true,
        expected: 4,
        reached: 4,
        passed: 4,
        failed: 0,
        notReached: 0
      });
      expect(report.assertionLedger.checkpoints.every(checkpoint =>
        checkpoint.reached
        && checkpoint.startedAt === "2026-07-15T10:00:00.000Z"
        && checkpoint.completedAt === "2026-07-15T10:00:01.000Z"
      )).toBe(true);
      expect(progress.filter(update => update.tcgen?.phase === "queued")).toHaveLength(4);
      expect(progress.filter(update => update.tcgen?.phase === "completed").map(update => update.tcgen)).toEqual(
        [1, 2, 3, 4].map(ordinal => expect.objectContaining({ ordinal, status: "passed" }))
      );
    } finally {
      backend.mockRestore();
    }
  });

  it("reports every simultaneous assertion failure from one backend invocation", async () => {
    const generated = await generatedFrameworkContract();
    const failedIds = new Set(generated.assertions.slice(0, 2).map(item => item.checkpointTestName));
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("failed", generated.generatedTestNames.map(name => ({
        name,
        status: failedIds.has(name) ? "failed" : "passed",
        ...(failedIds.has(name)
          ? { message: "ASSERT_TRUE failed: TcGenAssertionLedgerPassed returned FALSE (TCFRAMEWORK_ASSERTION_PASSED)" }
          : {})
      })))
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as { assertions: FrameworkAssertionEvidence[]; assertionLedger: FrameworkAssertionLedger };

      expect(report.assertions.filter(item => item.status === "failed")).toHaveLength(2);
      expect(report.assertions.filter(item => item.status === "failed").map(item => item.description)).toEqual([
        "first count should be 1",
        "second count should be 2"
      ]);
      expect(report.assertions.filter(item => item.status === "failed").every(
        item => item.executionEvidence === "assertion_checkpoint_failed"
      )).toBe(true);
      expect(report.assertions.filter(item => item.status === "passed")).toHaveLength(2);
      expect(report.assertionLedger).toMatchObject({ complete: true, passed: 2, failed: 2, notReached: 0 });
    } finally {
      backend.mockRestore();
    }
  });

  it("reports simultaneous native failures from fresh checkpoint instances in one backend run", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    const request = loadRequest("framework-limit-counter");
    const candidate = request.sources.find(source => source.path === "cut.st");
    if (!candidate) throw new Error("framework candidate fixture is missing");
    candidate.content = candidate.content.replace(
      "q_nCount := q_nCount + 1;",
      "q_nCount := q_nCount + 2;"
    );
    const backend = vi.spyOn(StrucppBackend.prototype, "run");
    try {
      await withEnv({ STRUCPP_PATH: repo }, async () => {
        const report = await toolHandlers.tcgen_st_test_run(
          request as unknown as Record<string, unknown>
        ) as {
          verdict: string;
          assertions: FrameworkAssertionEvidence[];
          assertionLedger: FrameworkAssertionLedger;
          backend: { executionAttempted: boolean };
        };

        expect(report.verdict).toBe("failed");
        expect(report.backend.executionAttempted).toBe(true);
        expect(report.assertions).toHaveLength(4);
        expect(report.assertions.every(assertion => assertion.status === "failed")).toBe(true);
        expect(report.assertions.every(assertion => assertion.reached)).toBe(true);
        expect(report.assertionLedger).toMatchObject({
          complete: true,
          expected: 4,
          reached: 4,
          passed: 0,
          failed: 4,
          notReached: 0
        });
        expect(backend).toHaveBeenCalledTimes(1);
      });
    } finally {
      backend.mockRestore();
    }
  }, 120_000);

  it("distinguishes a checkpoint that was not reached from one that failed", async () => {
    const generated = await generatedFrameworkContract();
    const notReached = generated.assertions[0].checkpointTestName;
    const failed = generated.assertions[1].checkpointTestName;
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("failed", generated.generatedTestNames.map(name => ({
        name,
        status: name === notReached || name === failed ? "failed" : "passed",
        ...(name === notReached
          ? { message: "ASSERT_TRUE failed: TcGenAssertionLedgerReached returned FALSE (TCFRAMEWORK_ASSERTION_REACHED)" }
          : name === failed
            ? { message: "ASSERT_TRUE failed: TcGenAssertionLedgerPassed returned FALSE (TCFRAMEWORK_ASSERTION_PASSED)" }
            : {})
      })))
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as { assertions: FrameworkAssertionEvidence[]; assertionLedger: FrameworkAssertionLedger };

      expect(report.assertions[0]).toMatchObject({
        reached: false,
        status: "not_reached",
        executionEvidence: "assertion_checkpoint_not_reached"
      });
      expect(report.assertions[1]).toMatchObject({
        reached: true,
        status: "failed",
        executionEvidence: "assertion_checkpoint_failed"
      });
      expect(report.assertionLedger).toMatchObject({ complete: true, passed: 2, failed: 1, notReached: 1 });
    } finally {
      backend.mockRestore();
    }
  });

  it("sanitizes descriptions and omits literal smoke assertions", () => {
    const source = [
      "FUNCTION_BLOCK FB_Test_Cut EXTENDS FB_TestCaseBase",
      "VAR",
      "    fbCut : FB_Cut;",
      "END_VAR",
      "m_xAssertTrue(TRUE, 'literal smoke');",
      "m_xAssertEqualDint(1, fbCut.q_nValue, 'token=abc Bearer eyJaaa.bbb.ccc C:\\Users\\alice\\secret.st');",
      "END_FUNCTION_BLOCK"
    ].join("\n");
    const assertions = extractFrameworkAssertionEvidence({
      source,
      sourcePath: "tests/cut.st",
      sourceSha256: sha256(source),
      sourceStartLine: 1,
      testFunctionBlock: "FB_Test_Cut",
      productionTarget: "FB_Cut"
    });

    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({
      sourceLine: 6,
      targetLinked: true,
      description: "token=<redacted> Bearer <redacted> <path>"
    });
    expect(JSON.stringify(assertions)).not.toContain("eyJaaa.bbb.ccc");
  });

  it("retains deterministic evidence for case-insensitive ST assertion spelling", async () => {
    const request = loadRequest("framework-limit-counter");
    const source = request.sources.find(item => item.path === "test.st");
    if (!source || !request.frameworkTest) throw new Error("framework fixture is incomplete");
    source.content = source.content
      .replace("m_xAssertEqualDint", "M_XASSERTEQUALDINT")
      .replace("m_xAssertEqualDint", "m_XaSsErTeQuAlDiNt");
    request.frameworkTest.targetMappings[0].testSourceSha256 = sha256(source.content);

    const first = await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    ) as { assertions: FrameworkAssertionEvidence[]; generatedTestNames: string[] };
    const second = await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    ) as { assertions: FrameworkAssertionEvidence[] };

    expect(first.assertions.slice(0, 2).map(item => item.assertionName)).toEqual([
      "M_XASSERTEQUALDINT",
      "m_XaSsErTeQuAlDiNt"
    ]);
    expect(first.assertions.map(item => item.assertionId)).toEqual(
      second.assertions.map(item => item.assertionId)
    );
    const executionNames = [
      ...first.generatedTestNames,
      ...first.assertions.map(item => item.checkpointTestName ?? "")
    ];
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("passed", executionNames.map(name => ({ name, status: "passed" })))
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        request as unknown as Record<string, unknown>
      ) as { assertions: FrameworkAssertionEvidence[] };
      expect(report.assertions.slice(0, 2).map(item => item.assertionName)).toEqual([
        "M_XASSERTEQUALDINT",
        "m_XaSsErTeQuAlDiNt"
      ]);
      expect(validateSemanticReport(report)).toEqual([]);
    } finally {
      backend.mockRestore();
    }
  });

  it("isolates mapped test blocks that share one aggregate source file", async () => {
    const request = loadRequest("framework-limit-counter");
    const testSource = request.sources.find(item => item.path === "test.st");
    const candidate = request.sources.find(item => item.path === "cut.st");
    if (!testSource || !candidate) throw new Error("framework fixture is incomplete");
    const secondTest = testSource.content
      .replaceAll("FB_Test_LimitCounter", "FB_Test_Other")
      .replaceAll("FB_LimitCounter", "FB_Other");
    testSource.content = (testSource.content + "\n" + secondTest).replace(/\r?\n/g, "\r\n");
    candidate.content += "\n" + candidate.content.replaceAll("FB_LimitCounter", "FB_Other");
    const aggregateHash = sha256(testSource.content);
    request.frameworkTest = {
      mode: "tcgen-test-framework",
      executionContract: "tcgen-framework-multiscan-v1",
      testFunctionBlocks: ["FB_Test_LimitCounter", "FB_Test_Other"],
      targetMappings: [
        {
          testFunctionBlock: "FB_Test_LimitCounter",
          productionTarget: "FB_LimitCounter",
          testSourcePath: "test.st",
          testSourceSha256: aggregateHash
        },
        {
          testFunctionBlock: "FB_Test_Other",
          productionTarget: "FB_Other",
          testSourcePath: "test.st",
          testSourceSha256: aggregateHash
        }
      ]
    };

    const generated = await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>
    ) as { assertions: FrameworkAssertionEvidence[]; diagnostics: Array<{ blocking: boolean; code: string }> };

    expect(generated.diagnostics.filter(item => item.blocking)).toEqual([]);
    expect(generated.assertions).toHaveLength(8);
    expect(generated.assertions.filter(item => item.testFunctionBlock === "FB_Test_LimitCounter")).toHaveLength(4);
    expect(generated.assertions.filter(item => item.testFunctionBlock === "FB_Test_Other")).toHaveLength(4);
    expect(generated.assertions.every(item => item.testSourceSha256 === aggregateHash)).toBe(true);
    expect(new Set(generated.assertions.map(item => item.assertionId)).size).toBe(8);
    expect(Math.min(...generated.assertions.filter(item => item.testFunctionBlock === "FB_Test_Other").map(item => item.sourceLine)))
      .toBeGreaterThan(Math.max(...generated.assertions.filter(item => item.testFunctionBlock === "FB_Test_LimitCounter").map(item => item.sourceLine)));
  });
});

function backendResult(
  status: "passed" | "failed",
  tests: Array<{ name: string; status: "passed" | "failed" | "skipped"; message?: string }>
) {
  return {
    status,
    executionAttempted: true,
    executable: "strucpp-win.exe",
    cliMode: "native" as const,
    version: "STruC++ version 0.5.13-tcgen.3",
    stdout: "",
    stderr: "",
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 1,
    diagnostics: [],
    tests: tests.map(test => ({
      ...test,
      startedAt: "2026-07-15T10:00:00.000Z",
      completedAt: "2026-07-15T10:00:01.000Z"
    })),
    standardFunctionBlockContracts: copyStandardFunctionBlockContracts(),
    standardFunctionBlockContractQualified: true
  };
}

async function generatedFrameworkContract(): Promise<{
  generatedTestNames: string[];
  assertions: FrameworkAssertionEvidence[];
}> {
  const generated = await toolHandlers.tcgen_st_test_generate(
    loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
  ) as {
    generatedTestNames: string[];
    assertions: FrameworkAssertionEvidence[];
  };
  return {
    assertions: generated.assertions,
    generatedTestNames: [
      ...generated.generatedTestNames,
      ...generated.assertions.map(assertion => assertion.checkpointTestName ?? "")
    ]
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
