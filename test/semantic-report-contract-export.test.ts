import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateStandardFunctionBlockContracts } from "../src/backends/StandardFunctionBlockContracts.js";
import { testedStrucppVersion } from "../src/backends/StrucppBackend.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { validateSemanticReport } from "../src/schemas/validators.js";
import { buildFrameworkAssertionLedger } from "../src/testspec/FrameworkAssertionEvidence.js";
import { packageVersion } from "../src/version.js";
import { exportSemanticReportContract } from "../scripts/export-semantic-report-contract.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("semantic-report contract exporter", () => {
  it("writes a deterministic complete Framework assertion report without guessing a commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgen-semantic-contract-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "first.json");
    const secondPath = join(directory, "nested", "second.json");
    const options = {
      repositoryRoot: process.cwd(),
      dependencies: {
        toolHandlers,
        buildFrameworkAssertionLedger,
        validateStandardFunctionBlockContracts,
        validateSemanticReport,
        testedStrucppVersion
      }
    };

    await exportSemanticReportContract(firstPath, options);
    await exportSemanticReportContract(secondPath, options);
    const first = await readFile(firstPath, "utf8");
    const second = await readFile(secondPath, "utf8");
    const fixture = JSON.parse(first) as Record<string, any>;
    const { mcpVersion, ...semanticReport } = fixture;

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(mcpVersion).toBe(packageVersion);
    expect(fixture).not.toHaveProperty("mcpCommit");
    expect(validateSemanticReport(semanticReport)).toEqual([]);
    expect(semanticReport).toMatchObject({
      schemaVersion: 2,
      testMode: "framework",
      verdict: "passed",
      backend: {
        executionAttempted: true,
        version: testedStrucppVersion,
        standardFunctionBlockContractQualified: true
      },
      assertionLedger: { complete: true, expected: 4, reached: 4, passed: 4 }
    });
    expect(semanticReport.assertions).toHaveLength(4);
    expect(semanticReport.assertions.every((row: Record<string, unknown>) =>
      row.reached === true
      && row.status === "passed"
      && typeof row.startedAt === "string"
      && typeof row.completedAt === "string"
    )).toBe(true);
    expect(semanticReport.assertionLedger.checkpoints.every((row: Record<string, unknown>) =>
      row.reached === true
      && row.status === "passed"
      && typeof row.startedAt === "string"
      && typeof row.completedAt === "string"
    )).toBe(true);
    expect(semanticReport.artifactIdentities.map((item: Record<string, unknown>) => item.role)).toEqual([
      "framework_st",
      "execution_adapter"
    ]);
    expect(semanticReport.frameworkTargetCoverage).toEqual([
      expect.objectContaining({
        testFunctionBlock: "FB_Test_LimitCounter",
        testSourcePath: "virtual-tests/FB_Test_LimitCounter.st"
      })
    ]);
    expect(semanticReport.assertions.every((row: Record<string, unknown>) =>
      row.sourcePath === "virtual-tests/FB_Test_LimitCounter.st"
    )).toBe(true);
    expect(semanticReport.artifactIdentities[0]).toMatchObject({
      role: "framework_st",
      path: "virtual-tests/FB_Test_LimitCounter.st",
      primary: true,
      visibility: "review"
    });
    expect(semanticReport.artifacts.testFile.path).toBe("virtual-tests/FB_Test_LimitCounter.st");
    expect(semanticReport.artifacts.frameworkTestFiles[0].path).toBe(
      "virtual-tests/FB_Test_LimitCounter.st"
    );
    expect(semanticReport.artifacts.testFile.content.startsWith(
      "(* TCGEN_VIRTUAL_TESTS_MANAGED_TEST:v1 *)\n"
    )).toBe(true);
    expect(
      semanticReport.artifacts.testFile.content.match(/TCGEN_VIRTUAL_TESTS_MANAGED_TEST:v1/g)
    ).toHaveLength(1);
    expect(
      createHash("sha256")
        .update(semanticReport.artifacts.testFile.content, "utf8")
        .digest("hex")
    ).toBe(semanticReport.frameworkTargetCoverage[0].testSourceSha256);
    expect(semanticReport.artifacts.testFile.content).toBe(
      semanticReport.artifacts.frameworkTestFiles[0].content
    );
    expect(semanticReport.artifacts.generatedTestFile.content).not.toBe(
      semanticReport.artifacts.testFile.content
    );
  });
});
