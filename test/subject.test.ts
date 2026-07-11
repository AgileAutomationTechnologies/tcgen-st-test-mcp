import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NormalizeRequest } from "../src/domain/models.js";
import { canonicalDependencyBundleSha256, canonicalizeDependencyBundle } from "../src/domain/sourceSubject.js";
import { TcGenToStrucppNormalizer } from "../src/normalizer/TcGenToStrucppNormalizer.js";
import { validateNormalizationReport } from "../src/schemas/validators.js";
import { toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("candidate-bound source subjects", () => {
  it("blocks a missing candidateSourcePath", async () => {
    const request = loadRequest("adder") as Partial<NormalizeRequest>;
    delete request.candidateSourcePath;

    const report = (await toolHandlers.tcgen_st_normalize(request as Record<string, unknown>)) as {
      compatibilityStatus: string;
      diagnostics: Array<{ code: string }>;
    };

    expect(report.compatibilityStatus).toBe("blocked");
    expect(report.diagnostics.map(item => item.code)).toContain("TCSUBJECT_CANDIDATE_PATH_REQUIRED");
    expect(validateNormalizationReport(report)).toEqual([]);
  });

  it("blocks an unmatched or duplicate candidate path", () => {
    const unmatched = loadRequest("adder");
    unmatched.candidateSourcePath = "other.st";
    const unmatchedResult = new TcGenToStrucppNormalizer().normalize(unmatched);
    expect(unmatchedResult.normalization.diagnostics.map(item => item.code)).toContain("TCSUBJECT_CANDIDATE_NOT_FOUND");
    expect(unmatchedResult.subject.candidateSha256).toBeUndefined();

    const duplicate = loadRequest("adder");
    duplicate.sources.push({ ...duplicate.sources[0] });
    const duplicateResult = new TcGenToStrucppNormalizer().normalize(duplicate);
    expect(duplicateResult.normalization.diagnostics.map(item => item.code)).toContain(
      "TCSUBJECT_CANDIDATE_PATH_AMBIGUOUS"
    );
    expect(duplicateResult.subject.candidateSha256).toBeUndefined();
  });

  it("hashes the exact candidate and a source-order-independent dependency bundle", () => {
    const request = loadRequest("framework-limit-counter");
    const expectedCandidate = request.sources.find(source => source.path === request.candidateSourcePath);
    expect(expectedCandidate).toBeDefined();

    const first = new TcGenToStrucppNormalizer().normalize(request).subject;
    const reordered = structuredClone(request);
    reordered.sources.reverse();
    const second = new TcGenToStrucppNormalizer().normalize(reordered).subject;

    expect(first.candidateSha256).toBe(sha256(expectedCandidate?.content ?? ""));
    expect(second.candidateSha256).toBe(first.candidateSha256);
    expect(second.dependencyBundleSha256).toBe(first.dependencyBundleSha256);

    reordered.sources.find(source => source.path === "test.st")!.content += "\n";
    const changedDependency = new TcGenToStrucppNormalizer().normalize(reordered).subject;
    expect(changedDependency.candidateSha256).toBe(first.candidateSha256);
    expect(changedDependency.dependencyBundleSha256).not.toBe(first.dependencyBundleSha256);
  });

  it("uses the canonical empty dependency bundle for a single source", () => {
    const subject = new TcGenToStrucppNormalizer().normalize(loadRequest("adder")).subject;
    expect(subject.dependencyBundleSha256).toBe(sha256("[]"));
  });

  it("matches the published cross-language golden hash vectors", () => {
    const contract = JSON.parse(readFileSync("schemas/dependency-bundle-hash-vectors.json", "utf8")) as {
      vectors: Array<{
        name: string;
        sources: Array<{ path: string; content: string }>;
        canonicalJson: string;
        sha256: string;
      }>;
    };

    expect(contract.vectors.map(vector => vector.name)).toEqual([
      "empty-bundle",
      "angle-brackets-and-apostrophe",
      "quotes-and-backslashes",
      "whitespace-and-controls",
      "non-ascii-and-surrogate-pair",
      "ordinal-source-order"
    ]);
    for (const vector of contract.vectors) {
      expect(canonicalizeDependencyBundle(vector.sources), vector.name).toBe(vector.canonicalJson);
      expect(canonicalDependencyBundleSha256(vector.sources), vector.name).toBe(vector.sha256);
    }
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
