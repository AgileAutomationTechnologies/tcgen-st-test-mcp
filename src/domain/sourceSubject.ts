import { createHash } from "node:crypto";
import { Diagnostic, NormalizeRequest, SemanticTestSubject, SourceFile, diagnostic } from "./models.js";

export interface SourceSubjectResolution {
  subject: SemanticTestSubject;
  diagnostics: Diagnostic[];
}

export function resolveSourceSubject(request: Pick<NormalizeRequest, "candidateSourcePath" | "sources">): SourceSubjectResolution {
  const candidateSourcePath = typeof request.candidateSourcePath === "string" ? request.candidateSourcePath : "";
  const sources = Array.isArray(request.sources) ? request.sources : [];
  const subject: SemanticTestSubject = { candidateSourcePath };

  if (!candidateSourcePath) {
    return {
      subject,
      diagnostics: [diagnostic("error", "TCSUBJECT_CANDIDATE_PATH_REQUIRED", "candidateSourcePath is required.")]
    };
  }

  const matches = sources
    .map((source, index) => ({ source, index }))
    .filter(item => item.source.path === candidateSourcePath);
  if (matches.length === 0) {
    return {
      subject,
      diagnostics: [
        diagnostic(
          "error",
          "TCSUBJECT_CANDIDATE_NOT_FOUND",
          `candidateSourcePath '${candidateSourcePath}' does not match any submitted source.`
        )
      ]
    };
  }
  if (matches.length > 1) {
    return {
      subject,
      diagnostics: [
        diagnostic(
          "error",
          "TCSUBJECT_CANDIDATE_PATH_AMBIGUOUS",
          `candidateSourcePath '${candidateSourcePath}' matches ${matches.length} submitted sources; exactly one match is required.`
        )
      ]
    };
  }

  const [{ source: candidate, index: candidateIndex }] = matches;
  const dependencies = sources.filter((_, index) => index !== candidateIndex);
  subject.candidateSha256 = sha256(candidate.content);
  subject.dependencyBundleSha256 = canonicalDependencyBundleSha256(dependencies);
  return { subject, diagnostics: [] };
}

export function canonicalDependencyBundleSha256(sources: SourceFile[]): string {
  return sha256(canonicalizeDependencyBundle(sources));
}

export function canonicalizeDependencyBundle(sources: SourceFile[]): string {
  const canonicalSources = sources
    .map(source => ({ path: source.path, content: source.content }))
    .sort(compareSources);
  return JSON.stringify(canonicalSources);
}

function compareSources(left: SourceFile, right: SourceFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.content < right.content) return -1;
  if (left.content > right.content) return 1;
  return 0;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
