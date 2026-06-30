import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/mcp/tools.js";

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
});
