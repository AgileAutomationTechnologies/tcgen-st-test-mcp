import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SemanticTestReport } from "../src/domain/models.js";
import {
  sanitizeCompilerDiagnostics,
  sanitizeCompilerOutput,
  structuredCompilerOutputDiagnostics
} from "../src/domain/reportSanitizer.js";
import { toolDefinitions, toolHandlers } from "../src/mcp/tools.js";
import { validateSemanticReport } from "../src/schemas/validators.js";
import { loadRequest, withEnv } from "./helpers.js";

type GenerationReport = {
  schemaVersion: 2;
  testMode: "generated" | "framework";
  coveredExecutableObjects: string[];
  generatedTestNames: string[];
  subject: SemanticTestReport["subject"];
  testFile: { path: string; content: string };
  generatedTestFile: { path: string; content: string };
  hashes: SemanticTestReport["hashes"];
};

describe("semantic report v2 contract", () => {
  it("keeps generated evidence identities consistent between generation and a blocked run", async () => {
    const request = loadRequest("adder");
    const generated = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as GenerationReport;
    const run = await unavailableBackendRun(request as unknown as Record<string, unknown>);

    expect(generated).toMatchObject({
      schemaVersion: 2,
      testMode: "generated",
      coveredExecutableObjects: ["FB_Adder"],
      generatedTestNames: ["adds two integers"]
    });
    expect(run).toMatchObject({
      schemaVersion: 2,
      testMode: "generated",
      coveredExecutableObjects: ["FB_Adder"],
      generatedTestNames: ["adds two integers"]
    });
    expect(run.subject).toEqual(generated.subject);
    expect(run.hashes.testSource).toBe(generated.hashes.testSource);
    expect(generated.hashes.testSource).toBe(sha256(generated.generatedTestFile.content));
    expect(run.artifacts?.generatedTestFile).toEqual(generated.generatedTestFile);
    expect(run.artifacts?.testFile).toEqual(generated.testFile);
    expect(validateSemanticReport(run)).toEqual([]);
    expect(validatePublishedSchema("schemas/semantic-report.schema.json", run)).toBe(true);
  });

  it("publishes deterministic framework names without claiming production-object coverage", async () => {
    const request = loadRequest("framework-limit-counter");
    const generated = (await toolHandlers.tcgen_st_test_generate(request as unknown as Record<string, unknown>)) as GenerationReport;
    const run = await unavailableBackendRun(request as unknown as Record<string, unknown>);

    expect(generated.testMode).toBe("framework");
    expect(generated.generatedTestNames).toEqual(["framework FB_Test_LimitCounter"]);
    expect(generated.coveredExecutableObjects).toEqual(["FB_Test_LimitCounter"]);
    expect(generated.coveredExecutableObjects).not.toContain("FB_LimitCounter");
    expect(run.testMode).toBe("framework");
    expect(run.generatedTestNames).toEqual(generated.generatedTestNames);
    expect(run.coveredExecutableObjects).toEqual(generated.coveredExecutableObjects);
    expect(run.subject).toEqual(generated.subject);
    expect(run.hashes.testSource).toBe(sha256(generated.generatedTestFile.content));
    expect(run.artifacts?.generatedTestFile).toEqual(generated.generatedTestFile);
    expect(validateSemanticReport(run)).toEqual([]);
  });

  it("returns generated ST artifacts when generation diagnostics block execution", async () => {
    const request = loadRequest("adder");
    request.testSpec!.tests[0].steps = [{ kind: "advanceTime", nanoseconds: -1 }];
    const run = (await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>)) as SemanticTestReport;

    expect(run.schemaVersion).toBe(2);
    expect(run.testMode).toBe("generated");
    expect(run.generatedTestNames).toEqual([]);
    expect(run.coveredExecutableObjects).toEqual([]);
    expect(run.artifacts?.generatedTestFile).toEqual({ path: "semantic_tests.st", content: "" });
    expect(run.diagnostics.map(item => item.code)).toContain("TCTEST_ADVANCE_TIME");
    expect(validateSemanticReport(run)).toEqual([]);
  });

  it("keeps a standalone legacy v1 report schema for existing framework consumers", async () => {
    const report = await unavailableBackendRun(loadRequest("framework-limit-counter") as unknown as Record<string, unknown>);
    const {
      testMode: _testMode,
      coveredExecutableObjects: _coveredExecutableObjects,
      generatedTestNames: _generatedTestNames,
      ...legacyFields
    } = report;
    const legacyReport = {
      ...legacyFields,
      schemaVersion: 1,
      summary: {
        passed: report.summary.passed,
        failed: report.summary.failed,
        skipped: report.summary.skipped,
        compileErrors: report.summary.compileErrors,
        runtimeErrors: report.summary.runtimeErrors
      }
    };

    expect(validatePublishedSchema("schemas/semantic-report-v1.schema.json", legacyReport)).toBe(true);
    expect(validatePublishedSchema("schemas/semantic-report.schema.json", legacyReport)).toBe(false);
  });

  it("sanitizes compiler output, assertion details, and diagnostic text", () => {
    const workspace = "C:\\Users\\alice\\AppData\\Local\\Temp\\tcgen-st-test-secret";
    const raw = `\u001b[31merror\u001b[0m at ${workspace}\\candidate.st\u0000`;
    const slashSpelling = `${workspace.replaceAll("\\", "/")}/semantic_tests.st`;

    expect(sanitizeCompilerOutput(`${raw}\n${slashSpelling}\n${workspace.toUpperCase()}\\other.st`, workspace)).toBe(
      "error at <workspace>\\candidate.st\n<workspace>/semantic_tests.st\n<workspace>\\other.st"
    );
    expect(
      sanitizeCompilerDiagnostics(
        [
          {
            severity: "error",
            blocking: true,
            code: "COMPILER_ERROR",
            message: raw,
            suggestion: `Inspect ${slashSpelling}`
          }
        ],
        workspace
      )[0]
    ).toMatchObject({
      message: "error at <workspace>\\candidate.st",
      suggestion: "Inspect <workspace>/semantic_tests.st"
    });

    const promoted = structuredCompilerOutputDiagnostics(
      "compile_error",
      { stdout: "", stderr: raw },
      workspace
    );
    expect(promoted).toEqual([
      expect.objectContaining({
        code: "STRUCPP_COMPILE_STDERR",
        blocking: true,
        message: "STruC++ compile stderr:\nerror at <workspace>\\candidate.st"
      })
    ]);
    expect(promoted[0].message).not.toContain(workspace);
  });

  it("advertises v2 result capability without changing the metadata-envelope version", () => {
    const runTool = toolDefinitions.find(tool => tool.name === "tcgen_st_test_run");
    const metadata = (runTool?.metadata as { tcgen: Record<string, unknown> }).tcgen;
    expect(metadata.contractVersion).toBe(1);
    expect(metadata.semanticReportSchemaVersion).toBe(2);
  });
});

async function unavailableBackendRun(request: Record<string, unknown>): Promise<SemanticTestReport> {
  return withEnv(
    {
      STRUCPP_PATH: resolve("missing-v2-contract-strucpp.exe"),
      STRUCPP_GPP_PATH: resolve("missing-v2-contract-g++.exe"),
      TCGEN_ST_TEST_PACK_DIR: undefined
    },
    async () => toolHandlers.tcgen_st_test_run(request) as Promise<SemanticTestReport>
  );
}

function validatePublishedSchema(path: string, value: unknown): boolean {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema)(value) as boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
