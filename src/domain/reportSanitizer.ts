import { tmpdir } from "node:os";
import { Diagnostic, SemanticVerdict, diagnostic } from "./models.js";
import type { NormalizedSourceMapEntry } from "../normalizer/TcGenToStrucppNormalizer.js";

const ansiEscape = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const unsafeControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeCompilerOutput(value: string, workspace?: string): string {
  let sanitized = value.replace(ansiEscape, "").replace(unsafeControlCharacters, "");
  for (const replacement of sensitivePathReplacements(workspace)) {
    for (const spelling of pathSpellings(replacement.path)) {
      sanitized = sanitized.replace(new RegExp(escapeRegExp(spelling), "gi"), replacement.token);
    }
  }
  return sanitized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeCompilerDiagnostics(diagnostics: Diagnostic[], workspace?: string): Diagnostic[] {
  return diagnostics.map(item => ({
    ...item,
    message: sanitizeCompilerOutput(item.message, workspace),
    ...(item.suggestion === undefined
      ? {}
      : { suggestion: sanitizeCompilerOutput(item.suggestion, workspace) }),
    ...(item.technicalEvidence === undefined
      ? {}
      : {
          technicalEvidence: {
            ...item.technicalEvidence,
            content: sanitizeCompilerOutput(item.technicalEvidence.content, workspace)
          }
        })
  }));
}

export function structuredCompilerOutputDiagnostics(
  verdict: SemanticVerdict,
  output: { stdout: string; stderr: string },
  workspace?: string,
  sourceMap: readonly NormalizedSourceMapEntry[] = []
): Diagnostic[] {
  if (verdict === "passed" || verdict === "partial" || verdict === "unsupported") return [];

  const category = verdict === "compile_error" ? "COMPILE" : verdict === "failed" ? "TEST" : "RUNTIME";
  const label = category === "COMPILE" ? "compile" : category === "TEST" ? "test failure" : "runtime";
  const diagnostics: Diagnostic[] = [];
  for (const channel of ["stderr", "stdout"] as const) {
    const completeSanitized = sanitizeCompilerOutput(output[channel], workspace).trim();
    if (!completeSanitized) continue;
    const displaySanitized = truncateDiagnosticText(completeSanitized);
    const provenance = compilerDiagnosticProvenance(verdict, completeSanitized, sourceMap);
    const compatibilityGap = strucppTwinCatCompatibilityGap(verdict, completeSanitized);
    const generatedArtifacts = generatedCppArtifacts(completeSanitized);
    const hasGeneratedCppEvidence = generatedArtifacts.length > 0;
    diagnostics.push(
      diagnostic(
        "error",
        compatibilityGap?.code ?? `STRUCPP_${category}_${channel.toUpperCase()}`,
        hasGeneratedCppEvidence
          ? `STruC++ ${label} ${channel} contains generated C++ diagnostics. The sanitized raw compiler output is retained under technicalEvidence with explicit generated-artifact provenance.`
          : `STruC++ ${label} ${channel}:\n${displaySanitized}`,
        {
          // These constructs are valid in the TcGen/TwinCAT source contract.
          // Treating the parser limitation as candidate provenance would send
          // an agent into an avoidance-style repair loop and change valid
          // production ST. Keep the exact source span for diagnosis while the
          // backend compatibility gap remains the authoritative owner.
          sourceKind: compatibilityGap ? "backend" : provenance.sourceKind,
          ...(provenance.original ? { original: provenance.original } : {}),
          ...(provenance.object ? { object: provenance.object } : {}),
          ...(compatibilityGap ? { suggestion: compatibilityGap.suggestion } : {}),
          ...(compatibilityGap ? { detail: compatibilityGap.detail } : {}),
          ...(hasGeneratedCppEvidence
            ? {
                technicalEvidence: {
                  kind: "compiler_output" as const,
                  channel,
                  content: completeSanitized,
                  sourceKind: "generated_cpp" as const,
                  generatedArtifacts
                }
              }
            : {})
        }
      )
    );
  }
  return diagnostics;
}

function generatedCppArtifacts(value: string): string[] {
  const artifacts = new Set<string>();
  for (const match of value.matchAll(/(?:^|[\\/\s:<])(?<name>generated\.cpp|test_main\.cpp)(?=[:\s>]|$)/gim)) {
    if (match.groups?.name) artifacts.add(match.groups.name.toLowerCase());
  }
  return [...artifacts].sort();
}

export function strucppTwinCatCompatibilityGap(
  verdict: SemanticVerdict,
  sanitizedOutput: string
): { code: string; suggestion: string; detail: "backend_incompatibility" } | undefined {
  if (verdict !== "compile_error") return undefined;
  if (
    /Expected\s+`END_GET`,\s+found\s+`VAR`/i.test(sanitizedOutput)
    || /Expected\s+`END_SET`,\s+found\s+`VAR`/i.test(sanitizedOutput)
  ) {
    return {
      code: "STRUCPP_TWINCAT_PROPERTY_ACCESSOR_LOCALS_UNSUPPORTED",
      detail: "backend_incompatibility",
      suggestion:
        "Update the pinned STruC++ runtime with native PROPERTY accessor-local declaration support; do not rewrite valid TwinCAT production ST to avoid this compiler limitation."
    };
  }
  if (
    /Expected\s+`END_CASE`,\s+found\s+identifier/i.test(sanitizedOutput)
    && /\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*,\s*[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/i.test(sanitizedOutput)
  ) {
    return {
      code: "STRUCPP_TWINCAT_GROUPED_QUALIFIED_CASE_LABELS_UNSUPPORTED",
      detail: "backend_incompatibility",
      suggestion:
        "Update the pinned STruC++ runtime with native grouped qualified CASE-label support; do not rewrite valid TwinCAT production ST to avoid this compiler limitation."
    };
  }
  if (bistableNamedPinContractMismatch(sanitizedOutput)) {
    return {
      code: "STRUCPP_TWINCAT_BISTABLE_NAMED_PIN_CONTRACT_MISMATCH",
      detail: "backend_incompatibility",
      suggestion:
        "The pinned semantic runtime rejected an RS/SR named input admitted by its qualified compiler-generated IEC function-block contract. Repair or update the pinned runtime; do not rewrite valid TwinCAT production ST."
    };
  }
  return undefined;
}

function bistableNamedPinContractMismatch(value: string): boolean {
  const mentionsAdmittedBlockPin =
    (/\bRS\b/i.test(value) && /\b(?:SET|RESET1)\b/i.test(value))
    || (/\bSR\b/i.test(value) && /\b(?:SET1|RESET)\b/i.test(value));
  const rejectsNamedMember =
    /\b(?:no|unknown|invalid|unexpected|missing)\b[^\r\n]{0,120}\b(?:member|field|input|pin|parameter|argument)\b/i.test(value)
    || /\b(?:member|field|input|pin|parameter|argument)\b[^\r\n]{0,120}\b(?:not found|not declared|unknown|invalid|does not exist)\b/i.test(value)
    || /\bhas no member(?: named)?\b/i.test(value)
    || /\bnot a member of\b/i.test(value);
  return mentionsAdmittedBlockPin && rejectsNamedMember;
}

export function compilerDiagnosticSourceKind(
  verdict: SemanticVerdict,
  sanitizedOutput: string,
  sourceMap: readonly NormalizedSourceMapEntry[] = []
): NonNullable<Diagnostic["sourceKind"]> {
  return compilerDiagnosticProvenance(verdict, sanitizedOutput, sourceMap).sourceKind;
}

function compilerDiagnosticProvenance(
  verdict: SemanticVerdict,
  sanitizedOutput: string,
  sourceMap: readonly NormalizedSourceMapEntry[]
): {
  sourceKind: NonNullable<Diagnostic["sourceKind"]>;
  original?: Diagnostic["original"];
  object?: string;
} {
  if (verdict === "backend_error" || verdict === "timeout") return { sourceKind: "backend" };
  if (verdict === "failed" && /\btcframework_execute_complete\b/i.test(sanitizedOutput)) {
    return { sourceKind: "generated_test_harness" };
  }
  if (verdict !== "compile_error") return { sourceKind: "candidate" };

  const mapped = normalizedSourceReferences(sanitizedOutput)
    .map(reference => sourceMap.find(entry =>
      entry.generatedPath.toLowerCase() === reference.path.toLowerCase()
      && reference.line >= entry.generatedStartLine
      && reference.line <= entry.generatedEndLine
    ))
    .filter((entry): entry is NormalizedSourceMapEntry => entry !== undefined);
  if (mapped.length > 0) {
    const kinds = new Set(mapped.map(entry => entry.sourceKind));
    if (kinds.size > 1) return { sourceKind: "mixed" };
    const first = mapped[0];
    return {
      sourceKind: first.sourceKind,
      original: { ...first.original },
      object: first.object
    };
  }

  // STruC++ emits generated test expressions into test_main.cpp while the
  // compiled production/dependency model is emitted into generated.cpp.
  // ST-front-end diagnostics retain the normalized/test source filename.
  const harness = /(?:^|[\\/\s:<])(?:test_main\.cpp|semantic_(?:framework_)?tests\.st|tcgen_framework_shim\.st)(?=[:\s>]|$)/i.test(sanitizedOutput);
  const candidate = /(?:^|[\\/\s:<])(?:generated\.cpp|normalized\.st)(?=[:\s>]|$)/i.test(sanitizedOutput);
  if (harness && candidate) return { sourceKind: "mixed" };
  if (harness) return { sourceKind: "generated_test_harness" };
  if (candidate) return { sourceKind: "candidate" };
  return { sourceKind: "unknown" };
}

function normalizedSourceReferences(value: string): Array<{ path: string; line: number }> {
  const references: Array<{ path: string; line: number }> = [];
  const expression = /(?:^|[\\/\s:<])(?<path>normalized\.st)(?::|\()(?<line>\d+)(?::\d+|,\d+\))?/gim;
  for (const match of value.matchAll(expression)) {
    const line = Number(match.groups?.line);
    if (match.groups?.path && Number.isInteger(line) && line > 0) {
      references.push({ path: match.groups.path, line });
    }
  }
  return references;
}

function pathSpellings(path: string): string[] {
  const spellings = [path, path.replace(/\\/g, "/"), path.replace(/\//g, "\\")];
  return [...new Set(spellings.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function sensitivePathReplacements(workspace?: string): Array<{ path: string; token: string }> {
  const replacements: Array<{ path: string; token: string }> = [];
  if (workspace) replacements.push({ path: workspace, token: "<workspace>" });
  const temp = tmpdir();
  if (!workspace || !pathSpellings(workspace).some(spelling => spelling.toLowerCase() === temp.toLowerCase())) {
    replacements.push({ path: temp, token: "<temp>" });
  }
  return replacements;
}

function truncateDiagnosticText(value: string, limit = 16_384): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... output truncated ...`;
}
