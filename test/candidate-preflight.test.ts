import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { SemanticTestReport } from "../src/domain/models.js";
import { toolHandlers } from "../src/mcp/tools.js";
import {
  candidateCompilePreflightContract,
  candidateCompilePreflightTestName
} from "../src/testspec/CandidateCompilePreflight.js";
import { loadRequest } from "./helpers.js";

describe("candidate compile preflight", () => {
  it("compiles the exact normalized sources with a deterministic target-neutral smoke test", async () => {
    let submittedTest = "";
    const backend = vi.spyOn(StrucppBackend.prototype, "run").mockImplementation(
      async (_sourcePaths, testPath) => {
        submittedTest = await readFile(testPath, "utf8");
        return {
          status: "passed",
          executionAttempted: true,
          executable: "strucpp-win.exe",
          cliMode: "native",
          version: "0.5.13-tcgen.2",
          gppExecutable: "g++.exe",
          stdout: `PASS: ${candidateCompilePreflightTestName}`,
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          diagnostics: [],
          tests: [{ name: candidateCompilePreflightTestName, status: "passed" }]
        };
      }
    );
    try {
      const request = preflightRequest();
      const report = await toolHandlers.tcgen_st_test_run(
        request as unknown as Record<string, unknown>
      ) as SemanticTestReport;

      expect(report.verdict).toBe("passed");
      expect(report.executionPurpose).toBe("candidate_compile_preflight");
      expect(report.artifacts).toBeUndefined();
      expect(report.backend.executionAttempted).toBe(true);
      expect(report.coveredExecutableObjects).toEqual(["FB_Adder"]);
      expect(report.generatedTestNames).toEqual([candidateCompilePreflightTestName]);
      expect(submittedTest).toContain("ASSERT_TRUE(TRUE);");
      expect(submittedTest).not.toContain("dut : FB_Adder");
      expect(backend).toHaveBeenCalledOnce();
    } finally {
      backend.mockRestore();
    }
  });

  it("rejects model-authored or malformed preflight specifications before backend execution", async () => {
    const backend = vi.spyOn(StrucppBackend.prototype, "run");
    try {
      const request = preflightRequest();
      request.testSpec!.tests[0].steps = [{ kind: "call" }];
      const report = await toolHandlers.tcgen_st_test_run(
        request as unknown as Record<string, unknown>
      ) as SemanticTestReport;

      expect(report.backend.executionAttempted).toBe(false);
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "TCCANDIDATE_PREFLIGHT_CONTRACT_INVALID",
        blocking: true
      }));
      expect(backend).not.toHaveBeenCalled();
    } finally {
      backend.mockRestore();
    }
  });
});

function preflightRequest() {
  const request = loadRequest("adder");
  request.options = {
    ...request.options,
    candidateCompilePreflight: true,
    executionPurpose: "candidate_compile_preflight",
    includeArtifacts: false
  };
  request.testSpec = {
    schemaVersion: 1,
    name: candidateCompilePreflightContract,
    target: { pouName: "FB_Adder", kind: "FUNCTION_BLOCK" },
    tests: [{ name: candidateCompilePreflightTestName, steps: [] }]
  };
  return request;
}
