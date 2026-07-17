import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/mcp/tools.js";
import { packageVersion } from "../src/version.js";

describe("MCP tool metadata", () => {
  it("publishes tcgen metadata contract for every tool", () => {
    for (const tool of toolDefinitions) {
      const metadata = (tool.metadata as Record<string, Record<string, unknown>>).tcgen;
      expect(metadata.contractVersion).toBe(1);
      expect(metadata.origin).toBe("pack");
      expect(metadata.serverId).toBe("tcgen_st_test");
      expect(metadata.capabilityGroup).toBe("build_validation");
      expect(metadata.mutatesProject).toBe(false);
    }
  });

  it("requires an exact candidate source path for source-processing tools", () => {
    for (const tool of toolDefinitions.filter(tool => tool.name !== "tcgen_st_backend_check")) {
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toContain("candidateSourcePath");
      expect(schema.properties).toHaveProperty("candidateSourcePath");
    }
  });

  it("advertises semantic report schema v2 on generate and run tools", () => {
    for (const tool of toolDefinitions.filter(tool => tool.name === "tcgen_st_test_generate" || tool.name === "tcgen_st_test_run")) {
      const metadata = (tool.metadata as Record<string, Record<string, unknown>>).tcgen;
      expect(metadata.semanticReportSchemaVersion).toBe(2);
      expect(metadata.capabilities).toContain("frameworkTargetCoverageV1");
      expect(metadata.capabilities).toContain("frameworkMultiScanV1");
      expect(metadata.capabilities).toContain("twinCatShortCircuitOperatorsV1");
      expect(metadata.capabilities).toContain("twinCatBistableAliasesV1");
      expect(metadata.capabilities).toContain("frameworkAssertionLedgerV1");
      expect(metadata.capabilities).toContain("frameworkAssertionProgressV1");
      if (tool.name === "tcgen_st_test_run") {
        expect(metadata.capabilities).toContain("candidateCompilePreflightV1");
      }
      expect(metadata.serverVersion).toBe("0.8.5");
      expect(metadata.evidencePaths).toEqual(
        expect.arrayContaining([
          "structuredContent.testMode",
          "structuredContent.coveredExecutableObjects",
          "structuredContent.frameworkTargetCoverage",
          "structuredContent.assertionLedger",
          "structuredContent.backend.executionAttempted",
          "structuredContent.backend.standardFunctionBlockContracts",
          "structuredContent.backend.standardFunctionBlockContractQualified",
          "structuredContent.generatedTestNames",
          "structuredContent.subject.candidateSha256",
          "structuredContent.subject.dependencyBundleSha256"
        ])
      );
    }
  });

  it("requires the multi-scan execution contract for Framework requests", () => {
    for (const tool of toolDefinitions.filter(tool => tool.name === "tcgen_st_test_generate" || tool.name === "tcgen_st_test_run")) {
      const schema = tool.inputSchema as {
        properties: {
          frameworkTest: {
            required: string[];
            properties: { executionContract: { const: string } };
          };
        };
      };
      expect(schema.properties.frameworkTest.required).toContain("executionContract");
      expect(schema.properties.frameworkTest.properties.executionContract.const)
        .toBe("tcgen-framework-multiscan-v1");
    }
  });

  it("keeps the advertised runtime version synchronized with the package", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(packageVersion).toBe(packageJson.version);
  });
});
