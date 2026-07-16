import { createHash } from "node:crypto";
import type {
  SemanticArtifactIdentity,
  SemanticArtifactRole,
  SourceFile
} from "./models.js";

type SemanticArtifactInput = SourceFile & {
  role: SemanticArtifactRole;
  primary: boolean;
  visibility: SemanticArtifactIdentity["visibility"];
};

/**
 * Build source-free, immutable identities for the exact submitted Framework
 * source and the separately generated offline execution adapter.  Consumers
 * must use role rather than legacy field names when choosing what to present.
 */
export function semanticArtifactIdentities(input: {
  mode: "generated" | "framework";
  executionAdapter: SourceFile;
  frameworkSources?: readonly SourceFile[];
}): SemanticArtifactIdentity[] {
  const artifacts: SemanticArtifactInput[] = [];
  if (input.mode === "framework") {
    for (const [index, source] of (input.frameworkSources ?? []).entries()) {
      artifacts.push({
        ...source,
        role: "framework_st",
        primary: index === 0,
        visibility: "review"
      });
    }
  }
  artifacts.push({
    ...input.executionAdapter,
    role: "execution_adapter",
    primary: input.mode !== "framework",
    visibility: "technical"
  });
  return artifacts.map(artifact => {
    const contentSha256 = sha256(artifact.content);
    return {
      artifactId: `artifact:${sha256([
        artifact.role,
        artifact.path,
        contentSha256
      ].join("\0"))}`,
      role: artifact.role,
      path: artifact.path,
      sha256: contentSha256,
      byteLength: Buffer.byteLength(artifact.content, "utf8"),
      primary: artifact.primary,
      visibility: artifact.visibility
    };
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
