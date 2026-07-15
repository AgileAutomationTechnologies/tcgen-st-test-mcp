import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { BackendRunResult, StrucppBackend } from "../backends/StrucppBackend.js";
import { NormalizeRequest, SemanticTestReport, SemanticTestSubject, diagnostic } from "../domain/models.js";
import {
  sanitizeCompilerDiagnostics,
  sanitizeCompilerOutput,
  structuredCompilerOutputDiagnostics
} from "../domain/reportSanitizer.js";
import { TcGenToStrucppNormalizer } from "../normalizer/TcGenToStrucppNormalizer.js";
import { normalizerOptionsForTestRequest, resolveTestFile, TestRequest } from "../testspec/TestFileResolver.js";
import { applyFrameworkAssertionExecution } from "../testspec/FrameworkAssertionEvidence.js";
import { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import { validateNormalizationReport, validateSemanticReport } from "../schemas/validators.js";
import { packageVersion } from "../version.js";

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
      subject: result.subject,
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
    const request = args as unknown as TestRequest;
    const normalized = new TcGenToStrucppNormalizer().normalize(request, normalizerOptionsForTestRequest(request));
    const generated = resolveTestFile(request, normalized);
    const normalizedForReport = withRuntimeSourceFiles(normalized, generated.sourceFiles);
    const hashes: SemanticTestReport["hashes"] = {
      ...normalizedForReport.hashes,
      testSource: generated.hash || sha256(generated.content)
    };
    return {
      schemaVersion: 2,
      testMode: generated.mode,
      coveredExecutableObjects: [...generated.coveredExecutableObjects],
      frameworkTargetCoverage: [...(generated.frameworkTargetCoverage ?? [])],
      assertions: [...(generated.assertions ?? [])],
      generatedTestNames: [...generated.generatedTestNames],
      ...(generated.executionContract ? { executionContract: generated.executionContract } : {}),
      subject: subjectForTest(normalizedForReport.subject, generated),
      normalization: normalizedForReport.normalization,
      normalizedFiles: request.options?.includeNormalizedSources === false ? [] : normalizedForReport.normalizedFiles,
      testFile: primaryTestArtifact(generated),
      generatedTestFile: { path: generated.path, content: generated.content },
      ...(generated.frameworkTestFiles?.length
        ? { frameworkTestFiles: generated.frameworkTestFiles.map(file => ({ ...file })) }
        : {}),
      diagnostics: [...normalizedForReport.normalization.diagnostics, ...generated.diagnostics],
      hashes
    };
  },

  async tcgen_st_test_run(args) {
    const request = args as unknown as TestRequest & {
      options?: NormalizeRequest["options"] & { timeoutMs?: number; keepWorkspace?: boolean; includeArtifacts?: boolean };
    };
    const normalized = new TcGenToStrucppNormalizer().normalize(request, {
      ...normalizerOptionsForTestRequest(request),
      requireCandidateScopeCoverage: true
    });
    const testFile = resolveTestFile(request, normalized);
    const normalizedForRun = withRuntimeSourceFiles(normalized, testFile.sourceFiles);
    const keepWorkspace = request.options?.keepWorkspace === true && process.env.TCGEN_ST_ALLOW_KEEP_WORKSPACE === "true";
    const keepWorkspaceDiagnostics =
      request.options?.keepWorkspace === true && !keepWorkspace
        ? [
            diagnostic("warning", "SANDBOX_KEEP_WORKSPACE_DISABLED", "keepWorkspace requires TCGEN_ST_ALLOW_KEEP_WORKSPACE=true and was ignored.", {
              blocking: false
            })
          ]
        : [];
    const preflightDiagnostics = [...normalizedForRun.normalization.diagnostics, ...testFile.diagnostics, ...keepWorkspaceDiagnostics];
    if (preflightDiagnostics.some(item => item.blocking)) {
      return buildReport({
        verdict: normalizedForRun.normalization.status === "blocked" ? "unsupported" : "backend_error",
        normalized: normalizedForRun,
        testFile,
        diagnostics: preflightDiagnostics,
        includeArtifacts: request.options?.includeArtifacts === true
      });
    }

    const workspaceManager = new WorkspaceManager();
    const workspace = await workspaceManager.create();
    let backendResult;
    try {
      const sourcePaths = await workspaceManager.writeFiles(workspace, normalizedForRun.normalizedFiles);
      const [testPath] = await workspaceManager.writeFiles(workspace, [{ path: testFile.path, content: testFile.content }]);
      backendResult = await new StrucppBackend().run(sourcePaths, testPath, { timeoutMs: request.options?.timeoutMs });
    } catch (error) {
      return buildReport({
        verdict: "backend_error",
        normalized: normalizedForRun,
        testFile,
        diagnostics: [
          ...preflightDiagnostics,
          diagnostic("error", "SANDBOX_WORKSPACE_ERROR", error instanceof Error ? error.message : String(error))
        ],
        includeArtifacts: request.options?.includeArtifacts === true,
        sanitizationWorkspace: workspace,
        workspace: keepWorkspace ? workspace : undefined
      });
    } finally {
      await workspaceManager.cleanup(workspace, keepWorkspace);
    }

    return buildReport({
      verdict: backendResult.status,
      normalized: normalizedForRun,
      testFile,
      diagnostics: [...preflightDiagnostics, ...backendResult.diagnostics],
      backendResult,
      includeArtifacts: request.options?.includeArtifacts === true,
      sanitizationWorkspace: workspace,
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
  testFile: {
    path: string;
    content: string;
    diagnostics: unknown[];
    hash: string;
    mode: "generated" | "framework";
    generatedTestNames: string[];
    coveredExecutableObjects: string[];
    frameworkTargetCoverage?: SemanticTestReport["frameworkTargetCoverage"];
    assertions?: SemanticTestReport["assertions"];
    frameworkTestFiles?: Array<{ path: string; content: string }>;
    discoveredFrameworkTests?: string[];
    selectedFrameworkTests?: string[];
  };
  diagnostics: SemanticTestReport["diagnostics"];
  backendResult?: BackendRunResult;
  includeArtifacts?: boolean;
  sanitizationWorkspace?: string;
  workspace?: string;
}): SemanticTestReport {
  const tests = (input.backendResult?.tests ?? []).map(test => ({
    ...test,
    name: sanitizeCompilerOutput(test.name, input.sanitizationWorkspace),
    ...(test.message === undefined ? {} : { message: sanitizeCompilerOutput(test.message, input.sanitizationWorkspace) })
  }));
  const assertions = applyFrameworkAssertionExecution(
    input.testFile.assertions ?? [],
    tests,
    input.sanitizationWorkspace
  );
  const executedTests = tests.filter(test => test.status === "passed" || test.status === "failed").length;
  // Both the legacy generated DSL and Framework ST emit a deterministic
  // executable test-name set. A backend result is trustworthy only when every
  // advertised wrapper ran exactly once; framework target/source coverage does
  // not make a partial execution acceptable.
  const generatedResultMismatch = generatedTestResultMismatch(
    input.testFile.generatedTestNames,
    tests
  );
  const completedBackendResultIsIncomplete =
    (input.verdict === "passed" || input.verdict === "failed")
    && (executedTests === 0 || generatedResultMismatch !== undefined);
  const backendVerdict = completedBackendResultIsIncomplete ? "backend_error" : input.verdict;
  const verdict = input.normalized.normalization.status === "partial" && backendVerdict === "passed" ? "partial" : backendVerdict;
  const backend: SemanticTestReport["backend"] = {
    name: "strucpp",
    executionAttempted: input.backendResult?.executionAttempted === true
  };
  if (input.backendResult?.executable) backend.executable = input.backendResult.executable;
  if (backend.executionAttempted && input.backendResult?.version) backend.version = input.backendResult.version;
  if (input.backendResult?.cliMode) backend.cliMode = input.backendResult.cliMode;
  if (input.backendResult?.gppExecutable) backend.gppExecutable = input.backendResult.gppExecutable;
  const testSource = input.testFile.hash || sha256(input.testFile.content);
  const hashes: SemanticTestReport["hashes"] = {
    ...input.normalized.hashes,
    testSource
  };

  const sanitizedDiagnostics = sanitizeCompilerDiagnostics(input.diagnostics, input.sanitizationWorkspace);
  if (input.verdict === "passed" && executedTests === 0 && !sanitizedDiagnostics.some(item => item.code === "STRUCPP_NO_TEST_RESULTS")) {
    sanitizedDiagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_NO_TEST_RESULTS",
        "The semantic backend returned a passing status without any executed tests; the result is not trusted."
      )
    );
  }
  if (
    (input.verdict === "passed" || input.verdict === "failed")
    && generatedResultMismatch
    && !sanitizedDiagnostics.some(item => item.code === "STRUCPP_INCOMPLETE_TEST_RESULTS")
  ) {
    sanitizedDiagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_INCOMPLETE_TEST_RESULTS",
        generatedResultMismatch
      )
    );
  }
  if (input.backendResult) {
    sanitizedDiagnostics.push(
      ...structuredCompilerOutputDiagnostics(
        verdict,
        input.backendResult,
        input.sanitizationWorkspace,
        input.normalized.sourceMap
      )
    );
  }
  const incompleteFrameworkExecution = frameworkExecutionIncomplete(input.testFile.mode, tests, input.backendResult);
  if (incompleteFrameworkExecution && !sanitizedDiagnostics.some(item => item.code === "TCFRAMEWORK_EXECUTE_INCOMPLETE")) {
    sanitizedDiagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_EXECUTE_INCOMPLETE",
        "The Framework execute phase remained busy after the configured offline scan limit. The exact test must initialize on m_xExecute(TRUE), advance one scan on each m_xExecute(FALSE), and clear _xPhaseBusy on every terminal path.",
        {
          sourceKind: "generated_test_harness",
          suggestion: "Repair the Framework ST execute-phase state machine; production code was not identified as the cause."
        }
      )
    );
  }

  const report: SemanticTestReport = {
    schemaVersion: 2,
    testMode: input.testFile.mode,
    coveredExecutableObjects: [...input.testFile.coveredExecutableObjects],
    frameworkTargetCoverage: [...(input.testFile.frameworkTargetCoverage ?? [])],
    assertions,
    generatedTestNames: [...input.testFile.generatedTestNames],
    subject: subjectForTest(input.normalized.subject, input.testFile),
    verdict,
    backend,
    normalization: input.normalized.normalization,
    summary: {
      passed: tests.filter(test => test.status === "passed").length,
      failed: tests.filter(test => test.status === "failed").length,
      skipped: tests.filter(test => test.status === "skipped").length,
      compileErrors: verdict === "compile_error" ? 1 : 0,
      runtimeErrors: verdict === "backend_error" ? 1 : 0,
      timedOut: verdict === "timeout" ? 1 : 0,
      unsupported: verdict === "unsupported" ? 1 : 0,
      total: Math.max(
        tests.length,
        input.testFile.generatedTestNames.length,
        ["compile_error", "backend_error", "timeout", "unsupported"].includes(verdict) ? 1 : 0
      )
    },
    tests,
    diagnostics: sanitizedDiagnostics,
    hashes,
    qualification:
      "Offline semantic test passed for the normalized STruC++ model. Final TwinCAT compilation or target validation may still be required for vendor libraries, task behavior, I/O, ADS, motion, lifecycle methods, and runtime-specific behavior."
  };
  if (input.includeArtifacts) {
    const artifacts: NonNullable<SemanticTestReport["artifacts"]> = {
      normalizedFiles: input.normalized.normalizedFiles,
      testFile: primaryTestArtifact(input.testFile),
      generatedTestFile: { path: input.testFile.path, content: input.testFile.content }
    };
    if (input.testFile.frameworkTestFiles?.length) {
      artifacts.frameworkTestFiles = input.testFile.frameworkTestFiles.map(file => ({ ...file }));
    }
    if (input.backendResult?.stdout !== undefined) artifacts.stdout = sanitizeCompilerOutput(input.backendResult.stdout, input.sanitizationWorkspace);
    if (input.backendResult?.stderr !== undefined) artifacts.stderr = sanitizeCompilerOutput(input.backendResult.stderr, input.sanitizationWorkspace);
    if (input.workspace) artifacts.workspace = input.workspace;
    report.artifacts = artifacts;
  }
  return withSemanticReportValidation(report);
}

export function generatedTestResultMismatch(
  generatedTestNames: readonly string[],
  tests: readonly SemanticTestReport["tests"][number][]
): string | undefined {
  const expected = [...generatedTestNames];
  const actual = tests.map(test => test.name);
  const expectedCounts = nameCounts(expected);
  const actualCounts = nameCounts(actual);
  const missingOrDuplicated = expected.filter(name => actualCounts.get(name) !== 1);
  const unexpected = actual.filter(name => !expectedCounts.has(name) || expectedCounts.get(name) !== 1);
  const nonExecuted = tests
    .filter(test => test.status !== "passed" && test.status !== "failed")
    .map(test => test.name);
  if (missingOrDuplicated.length === 0 && unexpected.length === 0 && nonExecuted.length === 0) {
    return undefined;
  }

  const details = [
    missingOrDuplicated.length > 0
      ? `missing or duplicated generated tests: ${uniqueNames(missingOrDuplicated).join(", ")}`
      : "",
    unexpected.length > 0
      ? `unexpected or duplicated backend tests: ${uniqueNames(unexpected).join(", ")}`
      : "",
    nonExecuted.length > 0
      ? `tests not executed: ${uniqueNames(nonExecuted).join(", ")}`
      : ""
  ].filter(Boolean);
  return "The semantic backend did not return exactly one executed result for every generated test ("
    + details.join("; ")
    + ").";
}

function frameworkExecutionIncomplete(
  mode: "generated" | "framework",
  tests: readonly SemanticTestReport["tests"][number][],
  backendResult: BackendRunResult | undefined
): boolean {
  if (mode !== "framework" || backendResult?.executionAttempted !== true) return false;
  const output = [
    backendResult.stdout,
    backendResult.stderr,
    ...tests.filter(test => test.status === "failed").map(test => test.message ?? "")
  ].join("\n");
  return /\btcframework_execute_complete\b/i.test(output);
}

function nameCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function withReportValidation<T extends { diagnostics: SemanticTestReport["diagnostics"] }>(
  report: T,
  validate: (value: unknown) => SemanticTestReport["diagnostics"]
): T {
  const diagnostics = validate(report);
  if (diagnostics.length === 0) return report;
  return { ...report, diagnostics: [...report.diagnostics, ...diagnostics] };
}

function withSemanticReportValidation(report: SemanticTestReport): SemanticTestReport {
  const diagnostics = validateSemanticReport(report);
  if (diagnostics.length === 0) return report;
  return {
    ...report,
    verdict: "backend_error",
    summary: {
      ...report.summary,
      runtimeErrors: Math.max(1, report.summary.runtimeErrors)
    },
    diagnostics: [...report.diagnostics, ...diagnostics]
  };
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    description,
    inputSchema,
    metadata: {
      tcgen: {
        contractVersion: 1,
        ...(name === "tcgen_st_test_generate" || name === "tcgen_st_test_run"
          ? {
              semanticReportSchemaVersion: 2,
              capabilities: ["frameworkTargetCoverageV1", "frameworkMultiScanV1"]
            }
          : {}),
        origin: "pack",
        serverId: "tcgen_st_test",
        serverVersion: packageVersion,
        childToolName: name,
        capabilityGroup: "build_validation",
        phaseHints: ["validate"],
        accessMode: name === "tcgen_st_backend_check" || name === "tcgen_st_test_run" ? "external_process" : "read",
        safetyLevel: name === "tcgen_st_backend_check" || name === "tcgen_st_test_run" ? "external_process" : "read_only",
        resultKind: name === "tcgen_st_test_run" ? "build_result" : "structured_summary",
        modelContentPath: "",
        evidencePaths: [
          "structuredContent.verdict",
          "structuredContent.testMode",
          "structuredContent.coveredExecutableObjects",
          "structuredContent.frameworkTargetCoverage",
          "structuredContent.assertions",
          "structuredContent.generatedTestNames",
          "structuredContent.backend.executionAttempted",
          "structuredContent.subject.candidateSha256",
          "structuredContent.subject.dependencyBundleSha256",
          "structuredContent.subject.discoveredFrameworkTests",
          "structuredContent.subject.selectedFrameworkTests",
          "structuredContent.normalization.status",
          "structuredContent.diagnostics"
        ],
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
    candidateSourcePath: {
      type: "string",
      minLength: 1,
      description: "Exact path of the single source candidate whose content is being validated."
    },
    sources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["path", "content"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    },
    scope: {
      type: "object",
      description: "Optional dependency focus. tcgen_st_test_run always requires every object from candidateSourcePath to remain selected and emitted.",
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
  if (requireTestSpec) {
    properties.frameworkTest = {
      type: "object",
      required: ["mode", "executionContract", "targetMappings"],
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["tcgen-test-framework"] },
        executionContract: { type: "string", const: "tcgen-framework-multiscan-v1" },
        testFunctionBlocks: {
          type: "array",
          items: { type: "string" },
          description: "When provided, must include every discovered submitted FB_Test_* framework test. Focus by omitting unrelated test sources."
        },
        targetMappings: {
          type: "array",
          minItems: 1,
          description: "Exact one-to-one bindings from submitted framework tests to candidate executable objects and their source identities.",
          items: {
            type: "object",
            required: ["testFunctionBlock", "productionTarget", "testSourcePath", "testSourceSha256"],
            additionalProperties: false,
            properties: {
              testFunctionBlock: { type: "string", minLength: 1 },
              productionTarget: { type: "string", minLength: 1 },
              testSourcePath: { type: "string", minLength: 1 },
              testSourceSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
            }
          }
        },
        maxScans: { type: "number" }
      }
    };
  }
  return {
    type: "object",
    required: ["candidateSourcePath", "sources"],
    additionalProperties: false,
    properties
  };
}

function primaryTestArtifact(testFile: {
  path: string;
  content: string;
  mode?: "generated" | "framework";
  frameworkTestFiles?: Array<{ path: string; content: string }>;
}): { path: string; content: string } {
  if (testFile.mode === "framework" && testFile.frameworkTestFiles?.length) {
    return { ...testFile.frameworkTestFiles[0] };
  }
  return { path: testFile.path, content: testFile.content };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function withRuntimeSourceFiles(
  normalized: ReturnType<TcGenToStrucppNormalizer["normalize"]>,
  sourceFiles: Array<{ path: string; content: string }>
): ReturnType<TcGenToStrucppNormalizer["normalize"]> {
  if (sourceFiles.length === 0) return normalized;
  const normalizedFiles = [...sourceFiles, ...normalized.normalizedFiles];
  const normalizedSource = normalizedFiles.map(file => file.content).join("\n\n");
  return {
    ...normalized,
    normalizedFiles,
    hashes: {
      ...normalized.hashes,
      normalizedSource: normalizedSource ? sha256(normalizedSource) : normalized.hashes.normalizedSource
    }
  };
}

function subjectForTest(
  subject: SemanticTestSubject,
  testFile: {
    mode?: "generated" | "framework";
    discoveredFrameworkTests?: string[];
    selectedFrameworkTests?: string[];
  }
): SemanticTestReport["subject"] {
  const reportSubject: SemanticTestReport["subject"] = {
    ...subject,
    // Invalid/ambiguous requests remain blocking reports, but schema-v2 never
    // publishes an identity-shaped object with fields silently omitted.
    candidateSha256: subject.candidateSha256 || sha256(""),
    dependencyBundleSha256: subject.dependencyBundleSha256 || sha256("[]")
  };
  if (testFile.mode !== "framework") return reportSubject;
  return {
    ...reportSubject,
    discoveredFrameworkTests: [...(testFile.discoveredFrameworkTests ?? [])],
    selectedFrameworkTests: [...(testFile.selectedFrameworkTests ?? [])]
  };
}
