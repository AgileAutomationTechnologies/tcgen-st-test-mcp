import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { toolHandlers } from "../src/mcp/tools.js";
import { validateNormalizationReport, validateSemanticReport, validateTcGenTestSpec } from "../src/schemas/validators.js";
import { loadRequest, localStrucppRepo, withEnv } from "./helpers.js";

describe("JSON schemas", () => {
  it("validates fixture test specs and normalization reports", async () => {
    const request = loadRequest("adder");
    expect(validateTcGenTestSpec(request.testSpec)).toEqual([]);
    const normalized = await toolHandlers.tcgen_st_normalize(request as unknown as Record<string, unknown>);
    expect(validateNormalizationReport(normalized)).toEqual([]);
    expect(validatePublishedSchema("schemas/normalization-report.schema.json", normalized)).toBe(true);
    expect(normalized).toMatchObject({
      subject: {
        candidateSourcePath: "adder.st",
        candidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyBundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
  });

  it("rejects semantically duplicate test names", () => {
    const request = loadRequest("adder");
    request.testSpec!.tests.push({
      name: `  ${request.testSpec!.tests[0].name.toUpperCase()}  `,
      steps: [{ kind: "call" }]
    });
    expect(validateTcGenTestSpec(request.testSpec)).toContainEqual(
      expect.objectContaining({ code: "TCTEST_DUPLICATE_NAME", blocking: true })
    );
  });

  it("validates semantic reports when native backend is available", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const report = await toolHandlers.tcgen_st_test_run(loadRequest("adder") as unknown as Record<string, unknown>);
      expect(validateSemanticReport(report)).toEqual([]);
      expect(report).toMatchObject({
        subject: {
          candidateSourcePath: "adder.st",
          candidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          dependencyBundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      });
    });
  }, 120_000);

  it("validates preflight semantic reports against the published report schema", async () => {
    const request = loadRequest("adder");
    await withEnv({ STRUCPP_PATH: resolve("missing-strucpp.exe"), STRUCPP_GPP_PATH: process.execPath }, async () => {
      const report = await toolHandlers.tcgen_st_test_run(request as unknown as Record<string, unknown>);
      expect(validateSemanticReport(report)).toEqual([]);
      expect(validatePublishedSchema("schemas/semantic-report.schema.json", report)).toBe(true);

      const duplicateNames = structuredClone(report) as { generatedTestNames: string[] };
      duplicateNames.generatedTestNames = [report.generatedTestNames[0], report.generatedTestNames[0]];
      expect(validateSemanticReport(duplicateNames)).toContainEqual(
        expect.objectContaining({ code: "TCREPORT_SCHEMA_VALIDATION", blocking: true })
      );
      expect(validatePublishedSchema("schemas/semantic-report.schema.json", duplicateNames)).toBe(false);

      for (const missingIdentity of ["candidateSha256", "dependencyBundleSha256"] as const) {
        const missing = structuredClone(report);
        delete missing.subject[missingIdentity];
        expect(validateSemanticReport(missing)).toContainEqual(
          expect.objectContaining({ code: "TCREPORT_SCHEMA_VALIDATION", blocking: true })
        );
        expect(validatePublishedSchema("schemas/semantic-report.schema.json", missing)).toBe(false);
      }
      const missingTestSource = structuredClone(report);
      delete missingTestSource.hashes.testSource;
      expect(validateSemanticReport(missingTestSource)).toContainEqual(
        expect.objectContaining({ code: "TCREPORT_SCHEMA_VALIDATION", blocking: true })
      );
      expect(validatePublishedSchema("schemas/semantic-report.schema.json", missingTestSource)).toBe(false);
    });
  });
});

function validatePublishedSchema(path: string, value: unknown): boolean {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema)(value) as boolean;
}
