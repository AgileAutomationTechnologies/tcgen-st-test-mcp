import { createHash } from "node:crypto";
import {
  Diagnostic,
  FrameworkAssertionEvidence,
  FrameworkTargetCoverage,
  FrameworkTargetMapping,
  SourceFile,
  TcGenObject,
  diagnostic
} from "../domain/models.js";
import { NormalizeResult } from "../normalizer/TcGenToStrucppNormalizer.js";
import { stripTrivia } from "../normalizer/tokenRewrite.js";
import { analyzeTargetAssertionLinkage } from "./FrameworkTargetAssertionLink.js";
import { extractFrameworkAssertionEvidence } from "./FrameworkAssertionEvidence.js";

export interface FrameworkTargetCoverageValidation {
  coverage: FrameworkTargetCoverage[];
  assertions: FrameworkAssertionEvidence[];
  frameworkTestFiles: SourceFile[];
  diagnostics: Diagnostic[];
}

export function validateFrameworkTargetCoverage(
  normalized: NormalizeResult,
  selectedTests: TcGenObject[],
  mappings: FrameworkTargetMapping[] | undefined,
  submittedSources: SourceFile[]
): FrameworkTargetCoverageValidation {
  const diagnostics: Diagnostic[] = [];
  const frameworkTestFiles = exactFrameworkTestFiles(selectedTests, submittedSources);
  if (!Array.isArray(mappings) || mappings.length === 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_TARGET_MAPPINGS_REQUIRED",
        "frameworkTest.targetMappings must bind every selected framework test to its exact source and production target."
      )
    );
    return { coverage: [], assertions: [], frameworkTestFiles, diagnostics };
  }

  const selectedByExactName = new Map(selectedTests.map(test => [test.name, test]));
  const executableByExactName = new Map(
    normalized.document.objects
      .filter(isProductionExecutable)
      .map(object => [object.name, object] as const)
  );
  const candidateExecutables = normalized.document.objects.filter(
    object => isProductionExecutable(object) && object.sourceSpan.path === normalized.subject.candidateSourcePath
  );
  const selectedMappingCounts = countExact(mappings, mapping => stringField(mapping, "testFunctionBlock"));
  const productionMappingCounts = countExact(mappings, mapping => stringField(mapping, "productionTarget"));
  const coverage: FrameworkTargetCoverage[] = [];
  const assertions: FrameworkAssertionEvidence[] = [];

  for (const rawMapping of mappings) {
    const mapping = normalizedMapping(rawMapping);
    const mappingDiagnostics: Diagnostic[] = [];
    if (!mapping) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TARGET_MAPPING_INVALID",
          "Every framework target mapping must contain non-empty testFunctionBlock, productionTarget, testSourcePath, and a lowercase SHA-256 testSourceSha256."
        )
      );
      continue;
    }

    const selectedTest = selectedByExactName.get(mapping.testFunctionBlock);
    const productionTarget = executableByExactName.get(mapping.productionTarget);
    const source = submittedSources.find(item => item.path === mapping.testSourcePath);
    let assertionCount = 0;
    let meaningfulAssertionCount = 0;
    let targetLinkedAssertionCount = 0;
    let targetReferenceCount = 0;

    if ((selectedMappingCounts.get(mapping.testFunctionBlock) ?? 0) !== 1) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TARGET_MAPPING_DUPLICATE_TEST",
          `Framework test '${mapping.testFunctionBlock}' must have exactly one target mapping.`
        )
      );
    }
    if ((productionMappingCounts.get(mapping.productionTarget) ?? 0) !== 1) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TARGET_MAPPING_DUPLICATE_TARGET",
          `Production target '${mapping.productionTarget}' must be covered by exactly one submitted framework test.`
        )
      );
    }
    if (!selectedTest) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TARGET_TEST_NOT_SELECTED",
          `Mapped framework test '${mapping.testFunctionBlock}' is not an exactly named selected FB_Test_* test.`
        )
      );
    } else if (!normalized.normalization.includedObjects.includes(selectedTest.qualifiedName)) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TARGET_TEST_NOT_INCLUDED",
          `Mapped framework test '${mapping.testFunctionBlock}' is excluded from the normalized execution scope.`
        )
      );
    }
    if (!productionTarget) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_PRODUCTION_TARGET_NOT_FOUND",
          `Mapped production target '${mapping.productionTarget}' was not found as an executable object in the submitted sources.`
        )
      );
    } else if (productionTarget.sourceSpan.path !== normalized.subject.candidateSourcePath) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_PRODUCTION_TARGET_NOT_CANDIDATE",
          `Mapped production target '${mapping.productionTarget}' is not part of candidate source '${normalized.subject.candidateSourcePath}'.`
        )
      );
    } else if (!normalized.normalization.includedObjects.includes(productionTarget.qualifiedName)) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_PRODUCTION_TARGET_NOT_INCLUDED",
          `Mapped production target '${mapping.productionTarget}' is excluded from the normalized execution scope.`
        )
      );
    }
    if (!source) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TEST_SOURCE_NOT_FOUND",
          `Mapped framework test source '${mapping.testSourcePath}' was not found exactly in sources.`
        )
      );
    } else {
      if (sha256(source.content) !== mapping.testSourceSha256) {
        mappingDiagnostics.push(
          diagnostic(
            "error",
            "TCFRAMEWORK_TEST_SOURCE_HASH_MISMATCH",
            `SHA-256 for framework test source '${mapping.testSourcePath}' does not match testSourceSha256.`
          )
        );
      }
      if (selectedTest && selectedTest.sourceSpan.path !== mapping.testSourcePath) {
        mappingDiagnostics.push(
          diagnostic(
            "error",
            "TCFRAMEWORK_TEST_SOURCE_MISMATCH",
            `Framework test '${mapping.testFunctionBlock}' is declared in '${selectedTest.sourceSpan.path}', not '${mapping.testSourcePath}'.`
          )
        );
      }
      if (selectedTest && selectedTest.sourceSpan.path === mapping.testSourcePath) {
        const testSource = sourceSpanText(source.content, selectedTest);
        const analysis = analyzeFrameworkTestSource(testSource, mapping.productionTarget);
        assertionCount = analysis.assertionCount;
        meaningfulAssertionCount = analysis.meaningfulAssertionCount;
        targetLinkedAssertionCount = analysis.targetLinkedAssertionCount;
        targetReferenceCount = analysis.targetReferenceCount;
        assertions.push(
          ...extractFrameworkAssertionEvidence({
            source: testSource,
            sourcePath: source.path,
            sourceSha256: sha256(source.content),
            sourceStartLine: selectedTest.sourceSpan.startLine,
            testFunctionBlock: mapping.testFunctionBlock,
            productionTarget: mapping.productionTarget
          })
        );
      }
    }

    if (selectedTest && source && targetReferenceCount === 0) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_PRODUCTION_TARGET_NOT_REFERENCED",
          `Framework test '${mapping.testFunctionBlock}' does not instantiate or reference production target '${mapping.productionTarget}'.`
        )
      );
    }
    if (selectedTest && source && assertionCount === 0) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_ASSERTIONS_REQUIRED",
          `Framework test '${mapping.testFunctionBlock}' contains no m_xAssert* invocation.`
        )
      );
    } else if (selectedTest && source && meaningfulAssertionCount === 0) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_MEANINGFUL_ASSERTION_REQUIRED",
          `Framework test '${mapping.testFunctionBlock}' contains only literal assertions and does not assert observed behavior.`
        )
      );
    }
    if (selectedTest && source && assertionCount > 0 && targetLinkedAssertionCount === 0) {
      mappingDiagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_TARGET_LINKED_ASSERTION_REQUIRED",
          `Framework test '${mapping.testFunctionBlock}' has no meaningful assertion whose observed value is data-linked to production target '${mapping.productionTarget}'. Unrelated locals and self-comparisons do not prove target behavior.`
        )
      );
    }

    diagnostics.push(...mappingDiagnostics);
    coverage.push({
      ...mapping,
      assertionCount,
      targetReferenceCount,
      verified: mappingDiagnostics.length === 0
    });
  }

  const missingTests = selectedTests
    .filter(test => (selectedMappingCounts.get(test.name) ?? 0) !== 1)
    .map(test => test.name);
  if (missingTests.length > 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_TARGET_MAPPING_INCOMPLETE",
        `Every selected framework test must be mapped exactly once; missing or duplicated: ${missingTests.join(", ")}.`
      )
    );
  }

  const missingTargets = candidateExecutables
    .filter(target => (productionMappingCounts.get(target.name) ?? 0) !== 1)
    .map(target => target.name);
  if (missingTargets.length > 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_PRODUCTION_COVERAGE_INCOMPLETE",
        `Every executable candidate object must be covered exactly once; missing or duplicated: ${missingTargets.join(", ")}.`
      )
    );
  }

  return {
    coverage,
    assertions: assertions.filter(
      (assertion, index, all) =>
        all.findIndex(candidate => candidate.assertionId === assertion.assertionId) === index
    ),
    frameworkTestFiles,
    diagnostics
  };
}

function normalizedMapping(value: unknown): FrameworkTargetMapping | undefined {
  if (!value || typeof value !== "object") return undefined;
  const allowedFields = new Set(["testFunctionBlock", "productionTarget", "testSourcePath", "testSourceSha256"]);
  if (Object.keys(value).some(field => !allowedFields.has(field))) return undefined;
  const candidate = value as Partial<FrameworkTargetMapping>;
  const testFunctionBlock = nonEmpty(candidate.testFunctionBlock);
  const productionTarget = nonEmpty(candidate.productionTarget);
  const testSourcePath = nonEmpty(candidate.testSourcePath);
  const testSourceSha256 = nonEmpty(candidate.testSourceSha256);
  if (!testFunctionBlock || !productionTarget || !testSourcePath || !testSourceSha256) return undefined;
  if (!/^[a-f0-9]{64}$/.test(testSourceSha256)) return undefined;
  return { testFunctionBlock, productionTarget, testSourcePath, testSourceSha256 };
}

function exactFrameworkTestFiles(selectedTests: TcGenObject[], submittedSources: SourceFile[]): SourceFile[] {
  const selectedPaths = new Set(selectedTests.map(test => test.sourceSpan.path));
  return submittedSources
    .filter(source => selectedPaths.has(source.path))
    .filter((source, index, all) => all.findIndex(candidate => candidate.path === source.path) === index)
    .map(source => ({ path: source.path, content: source.content }));
}

function isProductionExecutable(object: TcGenObject): boolean {
  return (object.kind === "functionBlock" || object.kind === "function" || object.kind === "program")
    && !/^FB_Test_/i.test(object.name)
    && object.name.toLowerCase() !== "fb_testcasebase"
    && object.name.toLowerCase() !== "fb_testrunner"
    && !isFrameworkRunnerProgram(object);
}

export function isFrameworkRunnerProgram(object: TcGenObject): boolean {
  if (object.kind !== "program") return false;
  const code = stripTrivia(`${object.declarationText}\n${object.implementationText}`);
  return /\bFB_TestRunner\b/i.test(code) && /\bm_udiRegisterTest\s*\(/i.test(code);
}

function analyzeFrameworkTestSource(source: string, productionTarget: string): {
  assertionCount: number;
  meaningfulAssertionCount: number;
  targetLinkedAssertionCount: number;
  targetReferenceCount: number;
} {
  const code = stripTrivia(source);
  const targetReferenceCount = countProductionTargetUses(code, productionTarget);
  const assertionArguments = assertionCallArguments(code);
  const targetLinkedAssertionCount = analyzeTargetAssertionLinkage(
    code,
    productionTarget
  ).targetLinkedAssertionCount;
  return {
    assertionCount: assertionArguments.length,
    meaningfulAssertionCount: assertionArguments.filter(hasObservedAssertionValue).length,
    targetLinkedAssertionCount,
    targetReferenceCount
  };
}

/**
 * Count executable uses of a production target rather than merely accepting
 * its type name in a VAR declaration.  A Framework test must both instantiate
 * the target and exercise the resulting instance (or call a FUNCTION target
 * directly) before it can claim target coverage.
 */
function countProductionTargetUses(code: string, productionTarget: string): number {
  const declaration = new RegExp(
    `\\b([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\.)*${escapeRegExp(productionTarget)}\\b[^;]*;`,
    "gi"
  );
  const instances: string[] = [];
  const executableCode = code.replace(declaration, match => {
    const instance = /^\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(match)?.[1];
    if (instance) instances.push(instance);
    return match.replace(/[^\r\n]/g, " ");
  });

  let uses = identifierCount(executableCode, productionTarget);
  for (const instance of new Set(instances.map(value => value.toLowerCase()))) {
    uses += identifierCount(executableCode, instance);
  }
  return uses;
}

function assertionCallArguments(code: string): string[] {
  const results: string[] = [];
  const matcher = /\bm_xAssert[A-Za-z0-9_]*\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(code)) !== null) {
    const open = code.indexOf("(", match.index);
    let depth = 1;
    let index = open + 1;
    while (index < code.length && depth > 0) {
      if (code[index] === "(") depth++;
      if (code[index] === ")") depth--;
      index++;
    }
    results.push(code.slice(open + 1, depth === 0 ? index - 1 : code.length));
    matcher.lastIndex = Math.max(index, matcher.lastIndex);
  }
  return results;
}

function hasObservedAssertionValue(argumentsText: string): boolean {
  const withoutNamedArguments = argumentsText.replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*:=/g, " ");
  const matcher = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(withoutNamedArguments)) !== null) {
    const identifier = match[0].toLowerCase();
    if (nonObservedAssertionIdentifiers.has(identifier)) continue;
    const suffix = withoutNamedArguments.slice(match.index + match[0].length).trimStart();
    if (suffix.startsWith("#")) continue;
    return true;
  }
  return false;
}

// A literal-only expression is still a smoke assertion even when it is
// decorated with IEC operators or typed-literal prefixes. Coverage is trusted
// only when at least one value comes from target/test state or a callable.
const nonObservedAssertionIdentifiers = new Set([
  "true", "false", "null",
  "not", "and", "and_then", "or", "or_else", "xor", "mod",
  "bool", "byte", "word", "dword", "lword",
  "sint", "int", "dint", "lint", "usint", "uint", "udint", "ulint",
  "real", "lreal", "string", "wstring",
  "time", "ltime", "date", "ldate", "tod", "ltod", "dt", "ldt"
]);

function sourceSpanText(content: string, object: TcGenObject): string {
  return content
    .split(/\r?\n/)
    .slice(Math.max(0, object.sourceSpan.startLine - 1), object.sourceSpan.endLine)
    .join("\n");
}

function identifierCount(code: string, identifier: string): number {
  const matcher = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "gi");
  return code.match(matcher)?.length ?? 0;
}

function countExact(
  values: FrameworkTargetMapping[],
  selector: (value: FrameworkTargetMapping) => string | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const selected = selector(value);
    if (selected) counts.set(selected, (counts.get(selected) ?? 0) + 1);
  }
  return counts;
}

function stringField(value: unknown, field: keyof FrameworkTargetMapping): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return nonEmpty((value as Partial<FrameworkTargetMapping>)[field]);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
