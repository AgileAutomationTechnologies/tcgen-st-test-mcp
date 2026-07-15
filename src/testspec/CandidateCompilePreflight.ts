import { Diagnostic, TcGenTestSpec, diagnostic } from "../domain/models.js";
import type { NormalizeResult } from "../normalizer/TcGenToStrucppNormalizer.js";
import type { ResolvedTestFile, TestRequest } from "./TestFileResolver.js";

export const candidateCompilePreflightContract = "tcgen-candidate-compile-preflight-v1";
export const candidateCompilePreflightTestName = "tcgen candidate compile preflight";

/**
 * Build the scheduler-owned compile smoke harness.
 *
 * The harness deliberately does not instantiate or call a candidate object.
 * STruC++ compiles every normalized source before compiling this test, which
 * validates FUNCTION, FUNCTION_BLOCK, and PROGRAM candidates uniformly. The
 * cloud never treats this internal PASS row as behavioural test evidence.
 */
export function resolveCandidateCompilePreflight(
  request: TestRequest,
  normalized: NormalizeResult
): ResolvedTestFile | undefined {
  if (request.options?.candidateCompilePreflight !== true) return undefined;
  const diagnostics = validateCandidateCompilePreflightRequest(request, normalized);
  const target = request.testSpec?.target?.pouName?.trim() ?? "";
  const content = [
    `TEST '${candidateCompilePreflightTestName}'`,
    "ASSERT_TRUE(TRUE);",
    "END_TEST",
    ""
  ].join("\n");
  return {
    path: "candidate_compile_preflight.st",
    content,
    diagnostics,
    hash: "",
    sourceFiles: [],
    mode: "generated",
    generatedTestNames: diagnostics.some(item => item.blocking)
      ? []
      : [candidateCompilePreflightTestName],
    coveredExecutableObjects: target ? [target] : [],
    frameworkTargetCoverage: [],
    assertions: [],
    frameworkTestFiles: []
  };
}

function validateCandidateCompilePreflightRequest(
  request: TestRequest,
  normalized: NormalizeResult
): Diagnostic[] {
  const spec = request.testSpec as TcGenTestSpec | undefined;
  if (
    request.options?.executionPurpose !== "candidate_compile_preflight"
    || spec?.schemaVersion !== 1
    || spec.name !== candidateCompilePreflightContract
    || spec.tests?.length !== 1
    || spec.tests[0]?.name !== candidateCompilePreflightTestName
    || !Array.isArray(spec.tests[0]?.steps)
    || spec.tests[0].steps.length !== 0
  ) {
    return [
      diagnostic(
        "error",
        "TCCANDIDATE_PREFLIGHT_CONTRACT_INVALID",
        "candidateCompilePreflight requires its reserved execution purpose and deterministic scheduler-owned v1 smoke specification."
      )
    ];
  }
  const target = spec.target?.pouName?.trim().toLowerCase();
  const included = new Set(
    normalized.normalization.includedObjects.map(name => name.toLowerCase())
  );
  if (!target || !included.has(target)) {
    return [
      diagnostic(
        "error",
        "TCCANDIDATE_PREFLIGHT_TARGET_INVALID",
        "candidateCompilePreflight target must identify an executable object included in the exact candidate scope."
      )
    ];
  }
  return [];
}
