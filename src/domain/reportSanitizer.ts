import { tmpdir } from "node:os";
import { Diagnostic, SemanticVerdict, diagnostic } from "./models.js";

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
      : { suggestion: sanitizeCompilerOutput(item.suggestion, workspace) })
  }));
}

export function structuredCompilerOutputDiagnostics(
  verdict: SemanticVerdict,
  output: { stdout: string; stderr: string },
  workspace?: string
): Diagnostic[] {
  if (verdict === "passed" || verdict === "partial" || verdict === "unsupported") return [];

  const category = verdict === "compile_error" ? "COMPILE" : verdict === "failed" ? "TEST" : "RUNTIME";
  const label = category === "COMPILE" ? "compile" : category === "TEST" ? "test failure" : "runtime";
  const diagnostics: Diagnostic[] = [];
  for (const channel of ["stderr", "stdout"] as const) {
    const sanitized = truncateDiagnosticText(sanitizeCompilerOutput(output[channel], workspace).trim());
    if (!sanitized) continue;
    diagnostics.push(
      diagnostic(
        "error",
        `STRUCPP_${category}_${channel.toUpperCase()}`,
        `STruC++ ${label} ${channel}:\n${sanitized}`,
        { sourceKind: compilerDiagnosticSourceKind(verdict, sanitized) }
      )
    );
  }
  return diagnostics;
}

export function compilerDiagnosticSourceKind(
  verdict: SemanticVerdict,
  sanitizedOutput: string
): NonNullable<Diagnostic["sourceKind"]> {
  if (verdict === "backend_error" || verdict === "timeout") return "backend";
  if (verdict !== "compile_error") return "candidate";

  // STruC++ emits generated test expressions into test_main.cpp while the
  // compiled production/dependency model is emitted into generated.cpp.
  // ST-front-end diagnostics retain the normalized/test source filename.
  const harness = /(?:^|[\\/\s:<])(?:test_main\.cpp|semantic_(?:framework_)?tests\.st)(?=[:\s>]|$)/i.test(sanitizedOutput);
  const candidate = /(?:^|[\\/\s:<])(?:generated\.cpp|normalized\.st)(?=[:\s>]|$)/i.test(sanitizedOutput);
  if (harness && candidate) return "mixed";
  if (harness) return "generated_test_harness";
  if (candidate) return "candidate";
  return "unknown";
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
