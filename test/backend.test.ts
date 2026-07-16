import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  StrucppBackend,
  backendChildEnvironment,
  classifyBackendRun,
  detectStrucppVersion,
  testedStrucppVersion,
  verifyRuntimeManifest,
} from "../src/backends/StrucppBackend.js";
import { Diagnostic, SemanticTestReport } from "../src/domain/models.js";
import {
  compilerDiagnosticSourceKind,
  structuredCompilerOutputDiagnostics,
  strucppTwinCatCompatibilityGap,
} from "../src/domain/reportSanitizer.js";
import { generatedTestResultMismatch, toolHandlers } from "../src/mcp/tools.js";
import {
  exampleNames,
  loadRequest,
  localStrucppRepo,
  qualifiedCompilerContractFixture,
  withEnv,
} from "./helpers.js";

describe("STruC++ backend", () => {
  it("retains the complete qualified downstream SemVer identity", () => {
    expect(detectStrucppVersion("STruC++ version 0.5.13-tcgen.4")).toBe(
      "0.5.13-tcgen.4",
    );
    expect(detectStrucppVersion("STruC++ version 0.5.13-tcgen.4+win64.3")).toBe(
      "0.5.13-tcgen.4+win64.3",
    );
    expect(detectStrucppVersion("0.5.13-tcgen.4")).toBe("0.5.13-tcgen.4");
    expect(detectStrucppVersion("evil 0.5.13-tcgen.4 suffix")).toBeUndefined();
    expect(
      detectStrucppVersion("STruC++ version 0.5.13-tcgen.4 extra"),
    ).toBeUndefined();
    expect(testedStrucppVersion).toBe("0.5.13-tcgen.4");
  });

  it("rejects passing backend output that omits or invents generated tests", () => {
    expect(
      generatedTestResultMismatch(
        ["accepts A", "accepts B"],
        [{ name: "accepts A", status: "passed" }],
      ),
    ).toContain("accepts B");
    expect(
      generatedTestResultMismatch(
        ["accepts A"],
        [
          { name: "accepts A", status: "passed" },
          { name: "stale test", status: "passed" },
        ],
      ),
    ).toContain("stale test");
    expect(
      generatedTestResultMismatch(
        ["accepts A", "accepts B"],
        [
          { name: "accepts A", status: "passed" },
          { name: "accepts B", status: "passed" },
        ],
      ),
    ).toBeUndefined();
  });

  it("never classifies an exit-0 backend result without parsed tests as passed", () => {
    expect(classifyBackendRun(0, "Compilation completed.", "", [])).toBe(
      "backend_error",
    );
    expect(
      classifyBackendRun(0, "SKIP: unavailable", "", [
        { name: "unavailable", status: "skipped" },
      ]),
    ).toBe("backend_error");
    expect(
      classifyBackendRun(0, "PASS: executes", "", [
        { name: "executes", status: "passed" },
      ]),
    ).toBe("passed");
  });

  it("labels generated C++ harness diagnostics separately from candidate diagnostics", () => {
    expect(
      compilerDiagnosticSourceKind(
        "compile_error",
        "<temp>/test_main.cpp:10: error: no member NOT_REAL",
      ),
    ).toBe("generated_test_harness");
    expect(
      compilerDiagnosticSourceKind(
        "compile_error",
        "<temp>/generated.cpp:10: error: invalid production expression",
      ),
    ).toBe("candidate");
    expect(
      compilerDiagnosticSourceKind("backend_error", "compiler process failed"),
    ).toBe("backend");
  });

  it("does not blame valid TwinCAT syntax on the production candidate when the pinned parser lacks it", () => {
    const accessor = [
      "Error compiling source files:",
      "normalized.st:244:1: error: Expected `END_GET`, found `VAR`.",
      " 244 | VAR",
    ].join("\n");
    const groupedCase = [
      "Error compiling source files:",
      "normalized.st:175:17: error: Expected `END_CASE`, found identifier `E_TPPATTERN`.",
      " 175 | E_TPPattern.Single, E_TPPattern.Delayed, E_TPPattern.Retriggerable:",
    ].join("\n");
    const namedBistablePin = [
      "Error: C++ compilation failed:",
      "<workspace>/generated.cpp:10959:20: error: 'class strucpp::RS' has no member named 'SET'",
      "10959 | RSRETRIGOUTPUT.SET = XSETRS;",
      "<workspace>/generated.cpp:10960:20: error: 'class strucpp::RS' has no member named 'RESET1'",
    ].join("\n");
    const invalidRsPins =
      "generated.cpp:1: error: 'class strucpp::RS' has no member named 'SET1'; RS.RESET";

    expect(
      strucppTwinCatCompatibilityGap("compile_error", accessor)?.code,
    ).toBe("STRUCPP_TWINCAT_PROPERTY_ACCESSOR_LOCALS_UNSUPPORTED");
    expect(
      strucppTwinCatCompatibilityGap("compile_error", groupedCase)?.code,
    ).toBe("STRUCPP_TWINCAT_GROUPED_QUALIFIED_CASE_LABELS_UNSUPPORTED");
    expect(
      strucppTwinCatCompatibilityGap("compile_error", namedBistablePin),
    ).toMatchObject({
      code: "STRUCPP_TWINCAT_BISTABLE_NAMED_PIN_CONTRACT_MISMATCH",
      detail: "backend_incompatibility",
    });
    expect(
      strucppTwinCatCompatibilityGap("compile_error", invalidRsPins),
    ).toBeUndefined();
    expect(
      strucppTwinCatCompatibilityGap(
        "compile_error",
        "normalized.st:1: error: Expected expression",
      ),
    ).toBeUndefined();

    const diagnostics = structuredCompilerOutputDiagnostics(
      "compile_error",
      { stdout: "", stderr: groupedCase },
      undefined,
      [
        {
          generatedPath: "normalized.st",
          generatedStartLine: 1,
          generatedEndLine: 300,
          original: {
            path: "pous/function blocks/fb_tppattern.tcpou",
            startLine: 20,
            endLine: 183,
          },
          object: "FB_TPPattern",
          sourceKind: "candidate",
        },
      ],
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "STRUCPP_TWINCAT_GROUPED_QUALIFIED_CASE_LABELS_UNSUPPORTED",
        sourceKind: "backend",
        object: "FB_TPPattern",
        original: expect.objectContaining({
          path: "pous/function blocks/fb_tppattern.tcpou",
        }),
      }),
    );

    const bistableDiagnostics = structuredCompilerOutputDiagnostics(
      "compile_error",
      { stdout: "", stderr: namedBistablePin },
      undefined,
      [
        {
          generatedPath: "normalized.st",
          generatedStartLine: 1,
          generatedEndLine: 100,
          original: {
            path: "pous/function blocks/fb_latch.tcpou",
            startLine: 1,
            endLine: 100,
          },
          object: "FB_Latch",
          sourceKind: "candidate",
        },
      ],
    );
    expect(bistableDiagnostics).toContainEqual(
      expect.objectContaining({
        code: "STRUCPP_TWINCAT_BISTABLE_NAMED_PIN_CONTRACT_MISMATCH",
        sourceKind: "backend",
        detail: "backend_incompatibility",
        message: expect.not.stringContaining("generated.cpp"),
        technicalEvidence: expect.objectContaining({
          sourceKind: "generated_cpp",
          generatedArtifacts: ["generated.cpp"],
          content: expect.stringContaining("RSRETRIGOUTPUT.SET"),
        }),
      }),
    );
  });

  it("never copies invocation grants or authorization secrets into backend child environments", async () => {
    await withEnv(
      {
        TCGEN_CHILD_TOOL_GRANT: "one-use-jwt",
        TCGEN_INVOCATION_GRANT: "another-jwt",
        AUTHORIZATION: "Bearer secret",
        NODE_OPTIONS: "--require=untrusted.js",
      },
      async () => {
        const compiler = join(tmpdir(), "tcgen-private", "bin", "g++.exe");
        const env = backendChildEnvironment(compiler);
        expect(env.TCGEN_CHILD_TOOL_GRANT).toBeUndefined();
        expect(env.TCGEN_INVOCATION_GRANT).toBeUndefined();
        expect(env.AUTHORIZATION).toBeUndefined();
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(env[process.platform === "win32" ? "Path" : "PATH"]).toBe(
          join(tmpdir(), "tcgen-private", "bin"),
        );
        expect(
          Object.keys(env).every((key) =>
            [
              "TEMP",
              "TMP",
              "HOME",
              "USERPROFILE",
              "SYSTEMROOT",
              "SystemRoot",
              "PATH",
              "Path",
            ].includes(key),
          ),
        ).toBe(true);
      },
    );
  });

  it("verifies every installed manifest entry and requires the IEC standard FB runtime", async () => {
    const validPack = await createRuntimeManifestFixture();
    const corruptPack = await createRuntimeManifestFixture({
      corruptPath: "backend/runtime/include/support.hpp",
    });
    const missingLibraryPack = await createRuntimeManifestFixture({
      omitStandardLibrary: true,
    });
    const missingContractPack = await createRuntimeManifestFixture({
      omitStandardContract: true,
    });
    try {
      await withEnv({ TCGEN_ST_TEST_PACK_DIR: validPack }, async () => {
        const diagnostics: Diagnostic[] = [];
        expect(await verifyRuntimeManifest(diagnostics)).toBe(true);
        expect(diagnostics).toEqual([]);

        const supportPath = join(
          validPack,
          "backend",
          "runtime",
          "include",
          "support.hpp",
        );
        await writeFile(
          supportPath,
          "corrupt-after-successful-preflight",
          "utf8",
        );
        const corruptAfterPreflight: Diagnostic[] = [];
        expect(await verifyRuntimeManifest(corruptAfterPreflight)).toBe(false);
        expect(corruptAfterPreflight).toContainEqual(
          expect.objectContaining({ code: "RUNTIME_INTEGRITY_FAILED" }),
        );

        await writeFile(supportPath, "support", "utf8");
        const repaired: Diagnostic[] = [];
        expect(await verifyRuntimeManifest(repaired)).toBe(true);
        expect(repaired).toEqual([]);
      });
      await withEnv({ TCGEN_ST_TEST_PACK_DIR: corruptPack }, async () => {
        const diagnostics: Diagnostic[] = [];
        expect(await verifyRuntimeManifest(diagnostics)).toBe(false);
        expect(diagnostics).toContainEqual(
          expect.objectContaining({ code: "RUNTIME_INTEGRITY_FAILED" }),
        );
      });
      await withEnv(
        { TCGEN_ST_TEST_PACK_DIR: missingLibraryPack },
        async () => {
          const diagnostics: Diagnostic[] = [];
          expect(await verifyRuntimeManifest(diagnostics)).toBe(false);
          expect(diagnostics).toContainEqual(
            expect.objectContaining({ code: "RUNTIME_MANIFEST_INVALID" }),
          );
          expect(diagnostics.map((item) => item.message).join("\n")).toContain(
            "backend/libs/iec-standard-fb.stlib",
          );
        },
      );
      await withEnv(
        { TCGEN_ST_TEST_PACK_DIR: missingContractPack },
        async () => {
          const diagnostics: Diagnostic[] = [];
          expect(await verifyRuntimeManifest(diagnostics)).toBe(false);
          expect(diagnostics).toContainEqual(
            expect.objectContaining({ code: "RUNTIME_MANIFEST_INVALID" }),
          );
          expect(diagnostics.map((item) => item.message).join("\n")).toContain(
            "backend/libs/iec-function-block-contracts.json",
          );
        },
      );
    } finally {
      await Promise.all(
        [validPack, corruptPack, missingLibraryPack, missingContractPack].map(
          (path) => rm(path, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("resolves the local STruC++ repo when STRUCPP_PATH points at the checkout", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv(
      { STRUCPP_PATH: repo, STRUCPP_GPP_PATH: undefined },
      async () => {
        const check = await new StrucppBackend().check();
        expect(check.available).toBe(true);
        expect(["node", "native"]).toContain(check.cliMode);
        expect(check.version).toContain("0.5.13-tcgen.4");
      },
    );
  }, 120_000);

  it("returns a clear backend error for invalid g++ path", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv(
      { STRUCPP_PATH: repo, STRUCPP_GPP_PATH: resolve("missing-gpp.exe") },
      async () => {
        const result = (await toolHandlers.tcgen_st_test_run(
          loadRequest("adder") as unknown as Record<string, unknown>,
        )) as SemanticTestReport;
        expect(result.verdict).toBe("backend_error");
        expect(result.diagnostics.map((item) => item.code)).toContain(
          "STRUCPP_GPP_PATH_INVALID",
        );
      },
    );
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
        "console.log('PASS: should not execute');",
      ].join("\n"),
      "utf8",
    );
    try {
      await withEnv(
        { STRUCPP_PATH: fakeCli, STRUCPP_GPP_PATH: process.execPath },
        async () => {
          const check = await new StrucppBackend().check();
          expect(check.available).toBe(false);
          expect(
            check.diagnostics.map((item) => item.message).join("\n"),
          ).toContain("0.5.13");
          expect(check.diagnostics).toContainEqual(
            expect.objectContaining({
              code: "STRUCPP_OVERRIDE_VERSION_MISMATCH",
              blocking: false,
            }),
          );
          expect(check.diagnostics).toContainEqual(
            expect.objectContaining({
              code: "STRUCPP_BUNDLED_FALLBACK_MISSING",
              blocking: true,
            }),
          );

          const report = (await toolHandlers.tcgen_st_test_run(
            loadRequest("adder") as unknown as Record<string, unknown>,
          )) as SemanticTestReport;
          expect(report.verdict).toBe("backend_error");
          expect(report.tests).toEqual([]);
          expect(report.diagnostics).toContainEqual(
            expect.objectContaining({
              code: "STRUCPP_OVERRIDE_VERSION_MISMATCH",
              blocking: false,
            }),
          );
          expect(report.diagnostics).toContainEqual(
            expect.objectContaining({
              code: "STRUCPP_BUNDLED_FALLBACK_MISSING",
              blocking: true,
            }),
          );
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails semantic preflight when standard runtime support is unavailable and re-probes after repair", async () => {
    const gppExecutable =
      process.env.STRUCPP_GPP_PATH ?? "C:\\msys64\\ucrt64\\bin\\g++.exe";
    const tempDir = await mkdtemp(join(tmpdir(), "tcgen-semantic-preflight-"));
    const fakeCli = join(tempDir, "fake-strucpp.mjs");
    try {
      await mkdir(join(tempDir, "libs"), { recursive: true });
      await writeFile(
        join(tempDir, "libs", "iec-function-block-contracts.json"),
        JSON.stringify(qualifiedCompilerContractFixture()),
        "utf8",
      );
      await writeFile(fakeCli, fakeSemanticRuntimeCli(false), "utf8");
      await withEnv(
        { STRUCPP_PATH: fakeCli, STRUCPP_GPP_PATH: gppExecutable },
        async () => {
          const failed = await new StrucppBackend().check();
          if (
            failed.diagnostics.some(
              (item) => item.code === "STRUCPP_GPP_PATH_INVALID",
            )
          )
            return;
          expect(failed.available).toBe(false);
          expect(failed.diagnostics).toContainEqual(
            expect.objectContaining({
              code: "STRUCPP_SEMANTIC_SELF_TEST_FAILED",
              sourceKind: "backend",
            }),
          );

          await writeFile(fakeCli, fakeSemanticRuntimeCli(true), "utf8");
          const repaired = await new StrucppBackend().check();
          expect(repaired.available).toBe(true);
          expect(repaired.version).toBe("0.5.13-tcgen.4");
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("can run fixture tests when STruC++ and g++ are available", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const check = await new StrucppBackend().check();
      if (!check.available || !check.gppAvailable) {
        expect(check.diagnostics.map((item) => item.code)).toContain(
          "STRUCPP_GPP_NOT_FOUND",
        );
        return;
      }
      for (const name of exampleNames) {
        const result = (await toolHandlers.tcgen_st_test_run(
          loadRequest(name) as unknown as Record<string, unknown>,
        )) as SemanticTestReport;
        expect(
          result.verdict,
          `${name}: ${result.diagnostics.map((item) => `${item.code}: ${item.message}`).join(" | ")}`,
        ).toBe("passed");
        expect(result.summary, name).toEqual({
          passed: result.tests.filter((test) => test.status === "passed")
            .length,
          failed: result.tests.filter((test) => test.status === "failed")
            .length,
          skipped: result.tests.filter((test) => test.status === "skipped")
            .length,
          compileErrors: 0,
          runtimeErrors: 0,
          timedOut: 0,
          unsupported: 0,
          total: result.generatedTestNames.length,
        });
        expect(
          result.tests.every((test) =>
            result.generatedTestNames.includes(test.name),
          ),
          name,
        ).toBe(true);
      }
    });
  }, 180_000);

  it("reports an actual malformed generated harness as generated_test_harness", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const check = await new StrucppBackend().check();
      if (!check.available || !check.gppAvailable) return;
      const request = loadRequest("adder");
      request.testSpec!.tests[0].steps = [
        { kind: "set", path: "$target.not_real", value: true },
        { kind: "call", arguments: { A: 2, B: 3 } },
      ];
      const result = (await toolHandlers.tcgen_st_test_run(
        request as unknown as Record<string, unknown>,
      )) as SemanticTestReport;
      expect(result.verdict).toBe("compile_error");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "STRUCPP_COMPILE_STDERR",
          sourceKind: "generated_test_harness",
        }),
      );
    });
  }, 60_000);

  it("advances a busy framework test through FALSE-trigger execute scans", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const check = await new StrucppBackend().check();
      if (!check.available || !check.gppAvailable) return;
      const result = (await toolHandlers.tcgen_st_test_run(
        loadRequest("framework-limit-counter") as unknown as Record<
          string,
          unknown
        >,
      )) as SemanticTestReport;
      expect(result.verdict).toBe("passed");
      expect(result.backend.executionAttempted).toBe(true);
      expect(result.summary.passed).toBe(1);
      expect(result.testMode).toBe("framework");
      expect(result.coveredExecutableObjects).toEqual(["FB_Test_LimitCounter"]);
      expect(result.generatedTestNames).toEqual([
        "framework FB_Test_LimitCounter",
      ]);
      expect(result.subject.selectedFrameworkTests).toEqual([
        "FB_Test_LimitCounter",
      ]);
    });
  }, 60_000);

  it("advances IEC timer time between resumed framework scans", async () => {
    const repo = localStrucppRepo();
    if (!repo) return;
    await withEnv({ STRUCPP_PATH: repo }, async () => {
      const check = await new StrucppBackend().check();
      if (!check.available || !check.gppAvailable) return;
      const request = loadRequest("framework-limit-counter");
      const candidate = request.sources.find(
        (source) => source.path === "cut.st",
      )!;
      const test = request.sources.find((source) => source.path === "test.st")!;
      const main = request.sources.find((source) => source.path === "main.st")!;
      candidate.content = [
        "FUNCTION_BLOCK FB_TimerProbe",
        "VAR_INPUT",
        "    i_xEnable : BOOL;",
        "END_VAR",
        "VAR_OUTPUT",
        "    q_xDone : BOOL;",
        "END_VAR",
        "VAR",
        "    tonDelay : TON;",
        "END_VAR",
        "tonDelay(IN := i_xEnable, PT := T#2ms);",
        "q_xDone := tonDelay.Q;",
        "END_FUNCTION_BLOCK",
        "",
      ].join("\n");
      test.content = [
        "FUNCTION_BLOCK FB_Test_TimerProbe EXTENDS FB_TestCaseBase",
        "VAR",
        "    fbCut : FB_TimerProbe;",
        "    udiStep : UDINT;",
        "END_VAR",
        "METHOD PUBLIC m_xExecute : BOOL",
        "VAR_INPUT",
        "    i_xTrigger : BOOL;",
        "END_VAR",
        "IF i_xTrigger THEN",
        "    _sTestCaseName := 'timer advances across offline scans';",
        "    _eState := eTestState_Running;",
        "    _eExecuteState := eTestState_Running;",
        "    udiStep := 0;",
        "    fbCut(i_xEnable := TRUE);",
        "    _xPhaseBusy := TRUE;",
        "ELSIF _xPhaseBusy THEN",
        "    IF (_eState = eTestState_Running) AND (_eExecuteState = eTestState_Running) THEN",
        "        CASE udiStep OF",
        "            0:",
        "                fbCut(i_xEnable := TRUE);",
        "                IF fbCut.q_xDone THEN",
        "                    m_xAssertTrue(fbCut.q_xDone, 'TON elapsed after simulated scans');",
        "                    _eState := eTestState_Passed;",
        "                    _eExecuteState := eTestState_Passed;",
        "                    _xPhaseBusy := FALSE;",
        "                END_IF",
        "            ELSE",
        "                _eState := eTestState_Passed;",
        "                _eExecuteState := eTestState_Passed;",
        "                _xPhaseBusy := FALSE;",
        "        END_CASE",
        "    ELSE",
        "        _xPhaseBusy := FALSE;",
        "    END_IF",
        "END_IF",
        "m_xExecute := TRUE;",
        "END_METHOD",
        "METHOD PUBLIC m_xIsBusy : BOOL",
        "m_xIsBusy := _xPhaseBusy;",
        "END_METHOD",
        "END_FUNCTION_BLOCK",
        "",
      ].join("\n");
      main.content = main.content.replaceAll(
        "FB_Test_LimitCounter",
        "FB_Test_TimerProbe",
      );
      request.frameworkTest!.testFunctionBlocks = ["FB_Test_TimerProbe"];
      request.frameworkTest!.targetMappings = [
        {
          testFunctionBlock: "FB_Test_TimerProbe",
          productionTarget: "FB_TimerProbe",
          testSourcePath: "test.st",
          testSourceSha256: createHash("sha256")
            .update(test.content, "utf8")
            .digest("hex"),
        },
      ];
      request.frameworkTest!.maxScans = 5;

      const result = (await toolHandlers.tcgen_st_test_run(
        request as unknown as Record<string, unknown>,
      )) as SemanticTestReport;

      expect(result.verdict).toBe("passed");
      expect(result.backend.executionAttempted).toBe(true);
      expect(result.tests).toEqual([
        expect.objectContaining({
          name: "framework FB_Test_TimerProbe",
          status: "passed",
          startedAt: expect.any(String),
          completedAt: expect.any(String),
        }),
      ]);
    });
  }, 60_000);
});

async function createRuntimeManifestFixture(
  options: {
    corruptPath?: string;
    omitStandardLibrary?: boolean;
    omitStandardContract?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tcgen-runtime-manifest-"));
  const files: Record<string, string> = {
    "runtime/tcgen-st-test-mcp.exe": "mcp",
    "backend/strucpp-win.exe": "strucpp",
    "toolchain/mingw64/bin/g++.exe": "compiler",
    "backend/runtime/include/support.hpp": "support",
    "backend/runtime/include/beckhoff_virtual.hpp": "beckhoff-runtime",
    "backend/libs/profiles/beckhoff-virtual.json": JSON.stringify({
      schemaVersion: 1,
      name: "beckhoff-virtual",
      runtimeProfile: "beckhoff-virtual-v1",
      excludedLibraries: ["additional-function-blocks"],
      libraries: [
        { name: "iec-standard-fb", path: "iec-standard-fb.stlib" },
        {
          name: "beckhoff-virtual-core",
          path: "beckhoff-virtual/beckhoff-virtual-core.stlib",
        },
        {
          name: "beckhoff-tc2-mc2",
          path: "beckhoff-virtual/beckhoff-tc2-mc2.stlib",
        },
      ],
    }),
    "backend/libs/beckhoff-virtual/beckhoff-virtual-core.stlib":
      "beckhoff-core",
    "backend/libs/beckhoff-virtual/beckhoff-tc2-mc2.stlib": "beckhoff-mc2",
    "backend/libs/sources/beckhoff-virtual-core/beckhoff-api-catalog.json":
      JSON.stringify({
        schemaVersion: 1,
        coverage: { indexedPages: 688, libraryIdentities: 34 },
      }),
  };
  if (!options.omitStandardLibrary)
    files["backend/libs/iec-standard-fb.stlib"] = "standard-library";
  if (!options.omitStandardContract) {
    files["backend/libs/iec-function-block-contracts.json"] = JSON.stringify(
      qualifiedCompilerContractFixture(),
    );
  }
  const entries = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirnameForTest(target), { recursive: true });
    await writeFile(target, content, "utf8");
    entries.push({
      path,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      size: Buffer.byteLength(content),
    });
  }
  await writeFile(
    join(root, "runtime-manifest.json"),
    JSON.stringify({ files: entries }),
    "utf8",
  );
  if (options.corruptPath) {
    await writeFile(
      join(root, ...options.corruptPath.split("/")),
      "corrupt",
      "utf8",
    );
  }
  return root;
}

function dirnameForTest(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function fakeSemanticRuntimeCli(passes: boolean): string {
  return [
    "if (process.argv.includes('--version')) {",
    "  console.log('STruC++ version 0.5.13-tcgen.4');",
    "  process.exit(0);",
    "}",
    passes
      ? "console.log('PASS: tcgen-runtime-self-test');"
      : "console.error(\"runtime_self_test.st:9: error: Undefined type 'TON'\");",
    `process.exit(${passes ? 0 : 1});`,
  ].join("\n");
}
