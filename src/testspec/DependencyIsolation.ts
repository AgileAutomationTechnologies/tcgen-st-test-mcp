import { NormalizeRequest, TcGenObject } from "../domain/models.js";
import { ReplaceObjectDecision } from "../normalizer/TcGenToStrucppNormalizer.js";

const executableKinds = new Set<TcGenObject["kind"]>([
  "function",
  "functionBlock",
  "program"
]);

/**
 * Replace project-owned executable bodies with signature-only declarations.
 * Candidate objects and data declarations are never changed.
 */
export function projectDependencyStubReplacer(
  request: NormalizeRequest,
  objects: readonly TcGenObject[]
): (object: TcGenObject) => ReplaceObjectDecision | undefined {
  const candidatePath = normalizePath(request.candidateSourcePath);
  const dependencyPaths = new Set(
    (request.projectDependencySourceSha256 ?? [])
      .map(row => normalizePath(row.path))
      .filter(path => Boolean(path) && path !== candidatePath)
  );
  const childrenByOwner = new Map<string, TcGenObject[]>();
  for (const object of objects) {
    if (!object.ownerName) continue;
    const key = object.ownerName.toLowerCase();
    const children = childrenByOwner.get(key) ?? [];
    children.push(object);
    childrenByOwner.set(key, children);
  }

  return object => {
    if (object.ownerName
        || !executableKinds.has(object.kind)
        || !dependencyPaths.has(normalizePath(object.sourceSpan.path))) {
      return undefined;
    }
    const unsupportedProgram = object.kind === "program";
    return {
      content: signatureOnlySource(
        object,
        childrenByOwner.get(object.qualifiedName.toLowerCase()) ?? []
      ),
      code: unsupportedProgram
        ? "TCFASTTEST_PROJECT_PROGRAM_UNSUPPORTED"
        : "TCFASTTEST_PROJECT_EXECUTABLE_STUBBED",
      message: unsupportedProgram
        ? `Project PROGRAM '${object.qualifiedName}' is unsupported for a fast isolated Virtual Test. Test the new block through an FB/function contract or use the later TwinCAT integration test.`
        : `Project executable '${object.qualifiedName}' was replaced by a signature-preserving offline stub; its implementation is outside fast isolated Virtual Tests.`,
      severity: unsupportedProgram ? "error" : "info",
      ruleId: "IsolateProjectExecutableDependency",
      sourceKind: "generated_test_harness"
    };
  };
}

function signatureOnlySource(
  object: TcGenObject,
  children: readonly TcGenObject[]
): string {
  const parts = [withoutTrailingTerminator(object.declarationText, terminatorFor(object.kind))];
  if (object.kind === "functionBlock") {
    for (const child of children) {
      if (child.kind !== "method" && child.kind !== "property") continue;
      const terminator = terminatorFor(child.kind);
      const declaration = withoutTrailingTerminator(child.declarationText, terminator);
      if (declaration.trim()) parts.push(`${declaration}\n${terminator}`);
    }
  }
  parts.push(terminatorFor(object.kind));
  return parts.filter(part => part.trim()).join("\n\n");
}

function withoutTrailingTerminator(source: string, terminator: string): string {
  if (!terminator) return source.trimEnd();
  const lines = source.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    if (lines[index].trim().toLowerCase() === terminator.toLowerCase()) {
      lines.splice(index, 1);
    }
    break;
  }
  return lines.join("\n").trimEnd();
}

function terminatorFor(kind: TcGenObject["kind"]): string {
  switch (kind) {
    case "function": return "END_FUNCTION";
    case "functionBlock": return "END_FUNCTION_BLOCK";
    case "program": return "END_PROGRAM";
    case "method": return "END_METHOD";
    case "property": return "END_PROPERTY";
    default: return "";
  }
}

function normalizePath(value: string): string {
  return String(value ?? "").trim().replace(/\\/g, "/").toLowerCase();
}
