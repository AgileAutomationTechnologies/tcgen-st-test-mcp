import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { StrucppBackend } from "../src/backends/StrucppBackend.js";
import { SemanticTestReport } from "../src/domain/models.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { exampleNames, loadRequest, localStrucppRepo, withEnv } from "./helpers.js";

describe("STruC++ backend", () => {
  it("resolves the local STruC++ repo when STRUCPP_PATH points at the checkout", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo, STRUCPP_GPP_PATH: undefined }, async () => {
      const check = await new StrucppBackend().check();
      expect(check.available).toBe(true);
      expect(check.cliMode).toBe("node");
      expect(check.version).toContain("0.5.12");
    });
  });

  it("returns a clear backend error for invalid g++ path", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo, STRUCPP_GPP_PATH: resolve("missing-gpp.exe") }, async () => {
      const result = (await toolHandlers.tcgen_st_test_run(loadRequest("adder") as unknown as Record<string, unknown>)) as SemanticTestReport;
      expect(result.verdict).toBe("backend_error");
      expect(result.diagnostics.map(item => item.code)).toContain("STRUCPP_GPP_PATH_INVALID");
    });
  });

  it("can run fixture tests when STruC++ and g++ are available", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const check = await new StrucppBackend().check();
      if (!check.available || !check.gppAvailable) {
        expect(check.diagnostics.map(item => item.code)).toContain("STRUCPP_GPP_NOT_FOUND");
        return;
      }
      for (const name of exampleNames) {
        const result = (await toolHandlers.tcgen_st_test_run(loadRequest(name) as unknown as Record<string, unknown>)) as SemanticTestReport;
        expect(result.verdict, name).toBe("passed");
      }
    });
  }, 180_000);
});
