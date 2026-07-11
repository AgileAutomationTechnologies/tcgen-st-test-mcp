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

  it("keeps the advertised runtime version synchronized with the package", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(packageVersion).toBe(packageJson.version);
  });
});
