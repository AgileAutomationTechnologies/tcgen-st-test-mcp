import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("rejects an installed STruC++ version that does not match the tested pin", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tcgen-version-mismatch-"));
    const fakeCli = join(tempDir, "fake-strucpp.mjs");
    await writeFile(
      fakeCli,
      [
        "if (process.argv.includes('--version')) {",
        "  console.log('STruC++ version 0.5.13');",
        "  process.exit(0);",
        "}",
        "console.log('PASS: should not execute');"
      ].join("\n"),
      "utf8"
    );
    try {
      await withEnv({ STRUCPP_PATH: fakeCli, STRUCPP_GPP_PATH: process.execPath }, async () => {
        const check = await new StrucppBackend().check();
        expect(check.available).toBe(false);
        expect(check.version).toContain("0.5.13");
        expect(check.diagnostics).toContainEqual(expect.objectContaining({ code: "STRUCPP_VERSION_MISMATCH", blocking: true }));

        const report = (await toolHandlers.tcgen_st_test_run(
          loadRequest("adder") as unknown as Record<string, unknown>
        )) as SemanticTestReport;
        expect(report.verdict).toBe("backend_error");
        expect(report.tests).toEqual([]);
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "STRUCPP_VERSION_MISMATCH", blocking: true }));
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  it("advances a busy framework test through repeated m_xIsBusy scans", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const check = await new StrucppBackend().check();
      if (!check.available || !check.gppAvailable) return;
      const result = (await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<string, unknown>
      )) as SemanticTestReport;
      expect(result.verdict).toBe("passed");
      expect(result.summary.passed).toBe(1);
      expect(result.subject.selectedFrameworkTests).toEqual(["FB_Test_LimitCounter"]);
    });
  }, 60_000);
});
