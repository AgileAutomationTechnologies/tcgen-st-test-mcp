import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StrucppBackend } from "../backends/StrucppBackend.js";
import { NormalizeRequest, SemanticTestReport, TcGenTestSpec, diagnostic } from "../domain/models.js";
import { TcGenToStrucppNormalizer } from "../normalizer/TcGenToStrucppNormalizer.js";
import { StrucppTestGenerator } from "../testspec/StrucppTestGenerator.js";
import { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import { validateNormalizationReport, validateSemanticReport } from "../schemas/validators.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export const toolDefinitions = [
  tool("tcgen_st_backend_check", "Check STruC++ backend availability and version.", {
    type: "object",
    properties: { backend: { type: "string", enum: ["strucpp"] } }
  }),
  tool("tcgen_st_normalize", "Normalize inline TcGen review-ST sources into STruC++-compatible ST without executing tests.", normalizeSchema(false)),
  tool("tcgen_st_test_generate", "Normalize inline TcGen review-ST sources and emit the generated STruC++ test file without execution.", normalizeSchema(true)),
  tool("tcgen_st_test_run", "Normalize inline TcGen review-ST sources, generate tests, execute STruC++, and return a semantic report.", normalizeSchema(true))
];

export const toolHandlers: Record<string, ToolHandler> = {
  async tcgen_st_backend_check() {
    return new StrucppBackend().check();
  },

  async tcgen_st_normalize(args) {
    const request = args as unknown as NormalizeRequest;
    const result = new TcGenToStrucppNormalizer().normalize(request);
    const response = {
      schemaVersion: 1,
      parseStatus: result.document.diagnostics.some(item => item.blocking) ? "error" : "ok",
      compatibilityStatus: result.normalization.status,
      normalizedFiles: request.options?.includeNormalizedSources === false ? [] : result.normalizedFiles,
      normalization: result.normalization,
      diagnostics: result.normalization.diagnostics,
      hashes: result.hashes
    };
    return withReportValidation(response, validateNormalizationReport);
  },

  async tcgen_st_test_generate(args) {
    const request = args as unknown as NormalizeRequest & { testSpec?: TcGenTestSpec };
    const normalized = new TcGenToStrucppNormalizer().normalize(request);
    const generated = request.testSpec
      ? new StrucppTestGenerator().generate(request.testSpec)
      : { path: "semantic_tests.st", content: "", diagnostics: [diagnostic("error", "TCTEST_SPEC_REQUIRED", "testSpec is required.")], hash: "" };
    const hashes: SemanticTestReport["hashes"] = { ...normalized.hashes };
    if (generated.hash) hashes.testSource = generated.hash;
    return {
      schemaVersion: 1,
      normalization: normalized.normalization,
      normalizedFiles: request.options?.includeNormalizedSources === false ? [] : normalized.normalizedFiles,
      generatedTestFile: { path: generated.path, content: generated.content },
      diagnostics: [...normalized.normalization.diagnostics, ...generated.diagnostics],
      hashes
    };
  },

  async tcgen_st_test_run(args) {
    const request = args as unknown as NormalizeRequest & {
      testSpec?: TcGenTestSpec;
      options?: NormalizeRequest["options"] & { timeoutMs?: number; keepWorkspace?: boolean; includeArtifacts?: boolean };
    };
    const normalized = new TcGenToStrucppNormalizer().normalize(request);
    const testFile = request.testSpec
      ? new StrucppTestGenerator().generate(request.testSpec)
      : { path: "semantic_tests.st", content: "", diagnostics: [diagnostic("error", "TCTEST_SPEC_REQUIRED", "testSpec is required.")], hash: "" };
    const keepWorkspace = request.options?.keepWorkspace === true && process.env.TCGEN_ST_ALLOW_KEEP_WORKSPACE === "true";
    const keepWorkspaceDiagnostics =
      request.options?.keepWorkspace === true && !keepWorkspace
        ? [
            diagnostic("warning", "SANDBOX_KEEP_WORKSPACE_DISABLED", "keepWorkspace requires TCGEN_ST_ALLOW_KEEP_WORKSPACE=true and was ignored.", {
              blocking: false
            })
          ]
        : [];
    const preflightDiagnostics = [...normalized.normalization.diagnostics, ...testFile.diagnostics, ...keepWorkspaceDiagnostics];
    if (preflightDiagnostics.some(item => item.blocking)) {
      return buildReport({
        verdict: normalized.normalization.status === "blocked" ? "unsupported" : "backend_error",
        normalized,
        testFile,
        diagnostics: preflightDiagnostics
      });
    }

    const workspaceManager = new WorkspaceManager();
    const workspace = await workspaceManager.create();
    let backendResult;
    try {
      const sourcePaths = await workspaceManager.writeFiles(workspace, normalized.normalizedFiles);
      const [testPath] = await workspaceManager.writeFiles(workspace, [{ path: testFile.path, content: testFile.content }]);
      backendResult = await new StrucppBackend().run(sourcePaths, testPath, { timeoutMs: request.options?.timeoutMs });
    } catch (error) {
      return buildReport({
        verdict: "backend_error",
        normalized,
        testFile,
        diagnostics: [
          ...preflightDiagnostics,
          diagnostic("error", "SANDBOX_WORKSPACE_ERROR", error instanceof Error ? error.message : String(error))
        ],
        includeArtifacts: request.options?.includeArtifacts === true,
        workspace: keepWorkspace ? workspace : undefined
      });
    } finally {
      await workspaceManager.cleanup(workspace, keepWorkspace);
    }

    return buildReport({
      verdict: backendResult.status,
      normalized,
      testFile,
      diagnostics: [...preflightDiagnostics, ...backendResult.diagnostics],
      backendResult,
      includeArtifacts: request.options?.includeArtifacts === true,
      workspace: keepWorkspace ? workspace : undefined
    });
  }
};

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[2] ?? "";
  const file = argv[3] ?? "";
  try {
    if (command === "backend-check") {
      console.log(JSON.stringify(await toolHandlers.tcgen_st_backend_check({}), null, 2));
      return 0;
    }
    if (!["normalize", "generate", "run"].includes(command) || !file) {
      console.error("Usage: tcgen-st-test <backend-check|normalize|generate|run> [request.json]");
      return 2;
    }
    const request = JSON.parse(await readFile(file, "utf8"));
    const name = command === "normalize" ? "tcgen_st_normalize" : command === "generate" ? "tcgen_st_test_generate" : "tcgen_st_test_run";
    console.log(JSON.stringify(await toolHandlers[name](request), null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function buildReport(input: {
  verdict: SemanticTestReport["verdict"] | "passed" | "failed";
  normalized: ReturnType<TcGenToStrucppNormalizer["normalize"]>;
  testFile: { path: string; content: string; diagnostics: unknown[]; hash: string };
  diagnostics: SemanticTestReport["diagnostics"];
  backendResult?: { executable?: string; version?: string; cliMode?: "native" | "node"; gppExecutable?: string; stdout: string; stderr: string; tests: SemanticTestReport["tests"] };
  includeArtifacts?: boolean;
  workspace?: string;
}): SemanticTestReport {
  const tests = input.backendResult?.tests ?? [];
  const verdict = input.normalized.normalization.status === "partial" && input.verdict === "passed" ? "partial" : input.verdict;
  const backend: SemanticTestReport["backend"] = { name: "strucpp" };
  if (input.backendResult?.executable) backend.executable = input.backendResult.executable;
  if (input.backendResult?.version) backend.version = input.backendResult.version;
  if (input.backendResult?.cliMode) backend.cliMode = input.backendResult.cliMode;
  if (input.backendResult?.gppExecutable) backend.gppExecutable = input.backendResult.gppExecutable;
  const hashes: SemanticTestReport["hashes"] = { ...input.normalized.hashes };
  const testSource = input.testFile.hash || (input.testFile.content ? sha256(input.testFile.content) : undefined);
  if (testSource) hashes.testSource = testSource;

  const report: SemanticTestReport = {
    schemaVersion: 1,
    verdict,
    backend,
    normalization: input.normalized.normalization,
    summary: {
      passed: tests.filter(test => test.status === "passed").length,
      failed: tests.filter(test => test.status === "failed").length,
      skipped: tests.filter(test => test.status === "skipped").length,
      compileErrors: verdict === "compile_error" ? 1 : 0,
      runtimeErrors: verdict === "backend_error" ? 1 : 0
    },
    tests,
    diagnostics: input.diagnostics,
    hashes,
    qualification:
      "Offline semantic test passed for the normalized STruC++ model. Final TwinCAT compilation or target validation may still be required for vendor libraries, task behavior, I/O, ADS, motion, lifecycle methods, and runtime-specific behavior."
  };
  if (input.includeArtifacts) {
    const artifacts: NonNullable<SemanticTestReport["artifacts"]> = {
      normalizedFiles: input.normalized.normalizedFiles,
      generatedTestFile: { path: input.testFile.path, content: input.testFile.content }
    };
    if (input.backendResult?.stdout !== undefined) artifacts.stdout = input.backendResult.stdout;
    if (input.backendResult?.stderr !== undefined) artifacts.stderr = input.backendResult.stderr;
    if (input.workspace) artifacts.workspace = input.workspace;
    report.artifacts = artifacts;
  }
  return withReportValidation(report, validateSemanticReport);
}

function withReportValidation<T extends { diagnostics: SemanticTestReport["diagnostics"] }>(
  report: T,
  validate: (value: unknown) => SemanticTestReport["diagnostics"]
): T {
  const diagnostics = validate(report);
  if (diagnostics.length === 0) return report;
  return { ...report, diagnostics: [...report.diagnostics, ...diagnostics] };
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    description,
    inputSchema,
    metadata: {
      tcgen: {
        contractVersion: 1,
        origin: "pack",
        serverId: "tcgen_st_test",
        childToolName: name,
        capabilityGroup: "build_validation",
        phaseHints: ["validate"],
        accessMode: name === "tcgen_st_backend_check" || name === "tcgen_st_test_run" ? "external_process" : "read",
        safetyLevel: name === "tcgen_st_backend_check" || name === "tcgen_st_test_run" ? "external_process" : "read_only",
        resultKind: name === "tcgen_st_test_run" ? "build_result" : "structured_summary",
        modelContentPath: "",
        evidencePaths: ["structuredContent.verdict", "structuredContent.normalization.status", "structuredContent.diagnostics"],
        dedupeKeyPaths: ["arguments", "structuredContent.hashes.request"],
        projectContextBinding: "none",
        structuredTextInput: true,
        mutatesProject: false,
        approvalKind: "none",
        repeatPolicy: "dedupe_by_arguments",
        largeResultRisk: name === "tcgen_st_test_run" ? "medium" : "low"
      }
    }
  };
}

function normalizeSchema(requireTestSpec: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    profile: { type: "string", enum: ["tcgen-strucpp-v1"] },
    sources: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    },
    scope: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "entrypoints"] },
        entrypoints: { type: "array", items: { type: "string" } },
        additionalSymbols: { type: "array", items: { type: "string" } }
      }
    },
    options: {
      type: "object",
      properties: {
        strict: { type: "boolean" },
        includeNormalizedSources: { type: "boolean" },
        timeoutMs: { type: "number" },
        keepWorkspace: { type: "boolean" },
        includeArtifacts: { type: "boolean" }
      }
    }
  };
  if (requireTestSpec) properties.testSpec = { type: "object" };
  return {
    type: "object",
    required: requireTestSpec ? ["sources", "testSpec"] : ["sources"],
    properties
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
