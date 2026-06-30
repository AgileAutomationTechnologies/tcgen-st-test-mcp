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
  });

  it("validates semantic reports when native backend is available", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const report = await toolHandlers.tcgen_st_test_run(loadRequest("adder") as unknown as Record<string, unknown>);
      expect(validateSemanticReport(report)).toEqual([]);
    });
  }, 30_000);
});
