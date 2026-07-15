import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import type { FrameworkAssertionEvidence } from "../src/domain/models.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { extractFrameworkAssertionEvidence } from "../src/testspec/FrameworkAssertionEvidence.js";
import { loadRequest } from "./helpers.js";

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
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("passed", [{
        name: "framework FB_Test_LimitCounter",
        status: "passed"
      }])
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as { verdict: string; assertions: FrameworkAssertionEvidence[] };

      expect(report.verdict).toBe("passed");
      expect(report.assertions).toHaveLength(4);
      expect(report.assertions.every(item => item.status === "passed")).toBe(true);
      expect(report.assertions.every(item => item.executionEvidence === "parent_test_passed")).toBe(true);
    } finally {
      backend.mockRestore();
    }
  });

  it("identifies only a uniquely named failed assertion and leaves the rest unknown", async () => {
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("failed", [{
        name: "framework FB_Test_LimitCounter",
        status: "failed",
        message: "ASSERT_EQ failed: actual='first count should be 1' expected=''"
      }])
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as { assertions: FrameworkAssertionEvidence[] };

      expect(report.assertions.filter(item => item.status === "failed")).toEqual([
        expect.objectContaining({
          description: "first count should be 1",
          executionEvidence: "backend_message"
        })
      ]);
      expect(report.assertions.filter(item => item.status === "unknown")).toHaveLength(3);
      expect(report.assertions.filter(item => item.status === "unknown").every(
        item => item.executionEvidence === "parent_test_failed"
      )).toBe(true);
    } finally {
      backend.mockRestore();
    }
  });

  it("never fabricates an individual failure when backend evidence is ambiguous", async () => {
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockResolvedValue(
      backendResult("failed", [{
        name: "framework FB_Test_LimitCounter",
        status: "failed",
        message: "ASSERT_EQ failed without submitted assertion identity"
      }])
    );
    try {
      const report = await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      ) as { assertions: FrameworkAssertionEvidence[] };

      expect(report.assertions.every(item => item.status === "unknown")).toBe(true);
      expect(report.assertions.some(item => item.status === "failed")).toBe(false);
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
    executable: "strucpp-win.exe",
    cliMode: "native" as const,
    version: "STruC++ version 0.5.12",
    stdout: "",
    stderr: "",
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 1,
    diagnostics: [],
    tests
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
