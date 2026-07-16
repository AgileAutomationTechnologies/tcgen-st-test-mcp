import { createHash } from "node:crypto";
import {
  Diagnostic,
  NormalizeRequest,
  NormalizationSummary,
  NormalizedFile,
  RewriteRecord,
  SemanticTestSubject,
  TcGenDocument,
  TcGenObject,
  diagnostic,
} from "../domain/models.js";
import { resolveSourceSubject } from "../domain/sourceSubject.js";
import { TcGenBundleParser } from "../parser/TcGenBundleParser.js";
import { rewriteIdentifiersOutsideTrivia } from "./tokenRewrite.js";

export interface NormalizeResult {
  document: TcGenDocument;
  subject: SemanticTestSubject;
  normalization: NormalizationSummary;
  normalizedFiles: NormalizedFile[];
  sourceMap: NormalizedSourceMapEntry[];
  hashes: {
    request: string;
    normalizedSource?: string;
    beckhoffSimulationIdentity?: string;
  };
}

export interface NormalizedSourceMapEntry {
  generatedPath: string;
  generatedStartLine: number;
  generatedEndLine: number;
  original: TcGenObject["sourceSpan"];
  object: string;
  sourceKind: "generated_test_harness" | "candidate";
}

export interface OmitObjectDecision {
  code: string;
  message: string;
  severity?: Diagnostic["severity"];
  ruleId?: string;
  affectsStatus?: boolean;
}

export interface ReplaceObjectDecision {
  content: string;
  code: string;
  message: string;
  severity?: Diagnostic["severity"];
  ruleId: string;
  sourceKind?: NormalizedSourceMapEntry["sourceKind"];
}

export interface NormalizeRuntimeOptions {
  omitObject?: (object: TcGenObject) => OmitObjectDecision | undefined;
  replaceObject?: (object: TcGenObject) => ReplaceObjectDecision | undefined;
  requireCandidateScopeCoverage?: boolean;
}

export class TcGenToStrucppNormalizer {
  normalize(
    request: NormalizeRequest,
    runtimeOptions: NormalizeRuntimeOptions = {},
  ): NormalizeResult {
    const strict = request.options?.strict !== false;
    const subjectResolution = resolveSourceSubject(request);
    const parser = new TcGenBundleParser();
    const document = parser.parseSources(request.sources ?? [], {
      autoClose: request.options?.autoClose === true,
    });
    const diagnostics: Diagnostic[] = [
      ...document.diagnostics,
      ...validateRequestSources(request.sources ?? []),
      ...subjectResolution.diagnostics,
    ];
    const rewrites: RewriteRecord[] = [];
    const profile = request.profile ?? "tcgen-strucpp-v1";
    if (profile !== "tcgen-strucpp-v1") {
      diagnostics.push(
        diagnostic(
          "error",
          "TCNORM_UNSUPPORTED_PROFILE",
          `Unsupported normalization profile '${profile}'.`,
        ),
      );
    }

    const selected = selectObjects(
      document.objects,
      request.scope,
      diagnostics,
      strict,
    );
    if (runtimeOptions.requireCandidateScopeCoverage) {
      validateCandidateScopeCoverage(
        document.objects,
        selected,
        request.candidateSourcePath,
        diagnostics,
      );
    }
    const omittedByRuntime = applyRuntimeOmissions(
      selected,
      diagnostics,
      runtimeOptions,
    );
    const selectedForEmission = selected.filter(
      (object) =>
        !omittedByRuntime.objects.has(object.qualifiedName.toLowerCase()),
    );
    const runtimeReplacements = applyRuntimeReplacements(
      selectedForEmission,
      diagnostics,
      rewrites,
      runtimeOptions,
    );
    analyzeCompatibility(
      selectedForEmission.filter(
        (object) =>
          !runtimeReplacements.has(object.qualifiedName.toLowerCase()),
      ),
      diagnostics,
      strict,
    );
    const symbolMap = buildSymbolMap(selectedForEmission, diagnostics);
    const emitted = emitNormalized(
      selectedForEmission,
      symbolMap,
      diagnostics,
      rewrites,
      strict,
      runtimeReplacements,
    );
    if (runtimeOptions.requireCandidateScopeCoverage) {
      validateCandidateEmissionCoverage(
        document.objects,
        emitted.includedIds,
        request.candidateSourcePath,
        diagnostics,
      );
    }
    const normalizedContent = emitted.files
      .map((file) => file.content)
      .join("\n\n");
    const omittedObjects = [...emitted.omitted, ...omittedByRuntime.names];
    const blockedObjects = selectedForEmission
      .filter((object) =>
        diagnostics.some(
          (item) => item.blocking && item.object === object.qualifiedName,
        ),
      )
      .map((object) => object.qualifiedName);
    const hasBlocking = diagnostics.some((item) => item.blocking);
    const status = hasBlocking
      ? "blocked"
      : rewrites.length > 0 ||
          diagnostics.some(
            (item) =>
              item.code.startsWith("TCNORM_") ||
              item.code.startsWith("TCFRAMEWORK_"),
          )
        ? "rewritten"
        : emitted.omitted.length > 0 || omittedByRuntime.affectsPartialStatus
          ? "partial"
          : "exact";

    const hashes: NormalizeResult["hashes"] = {
      request: hashJson(request),
    };
    if (normalizedContent) hashes.normalizedSource = sha256(normalizedContent);

    return {
      document,
      subject: subjectResolution.subject,
      normalization: {
        profile: "tcgen-strucpp-v1",
        status,
        includedObjects: emitted.included,
        omittedObjects,
        blockedObjects,
        symbolMap: Object.fromEntries(symbolMap),
        rewrites,
        diagnostics,
      },
      normalizedFiles: emitted.files,
      sourceMap: emitted.sourceMap,
      hashes,
    };
  }
}

function applyRuntimeReplacements(
  selected: TcGenObject[],
  diagnostics: Diagnostic[],
  rewrites: RewriteRecord[],
  runtimeOptions: NormalizeRuntimeOptions,
): Map<string, ReplaceObjectDecision> {
  const replacements = new Map<string, ReplaceObjectDecision>();
  if (!runtimeOptions.replaceObject) return replacements;
  for (const object of selected) {
    const decision = runtimeOptions.replaceObject(object);
    if (!decision) continue;
    replacements.set(object.qualifiedName.toLowerCase(), decision);
    diagnostics.push(
      diagnostic(decision.severity ?? "info", decision.code, decision.message, {
        blocking: false,
        object: object.qualifiedName,
        original: object.sourceSpan,
        ruleId: decision.ruleId,
      }),
    );
    const originalText = [
      object.declarationText,
      object.implementationText,
      terminatorFor(object.kind),
    ]
      .filter(Boolean)
      .join("\n");
    addRewrite(
      rewrites,
      decision.ruleId,
      object,
      originalText,
      decision.content,
    );
  }
  return replacements;
}

function validateCandidateEmissionCoverage(
  objects: TcGenObject[],
  includedObjectIds: string[],
  candidateSourcePath: string,
  diagnostics: Diagnostic[],
): void {
  const included = new Set(includedObjectIds);
  const omitted = objects
    .filter(
      (object) =>
        object.sourceSpan.path === candidateSourcePath &&
        !included.has(object.id),
    )
    .map((object) => object.qualifiedName)
    .sort();
  if (omitted.length === 0) return;
  diagnostics.push(
    diagnostic(
      "error",
      "TCSUBJECT_CANDIDATE_NOT_EMITTED",
      `Candidate object${omitted.length === 1 ? " was" : "s were"} not emitted into the compiled semantic source: ${omitted.join(", ")}.`,
    ),
  );
}

function validateCandidateScopeCoverage(
  objects: TcGenObject[],
  selected: TcGenObject[],
  candidateSourcePath: string,
  diagnostics: Diagnostic[],
): void {
  const selectedIds = new Set(selected.map((object) => object.id));
  const excluded = objects.filter(
    (object) =>
      object.sourceSpan.path === candidateSourcePath &&
      !selectedIds.has(object.id),
  );
  if (excluded.length === 0) return;
  const names = excluded.map((object) => object.qualifiedName).sort();
  diagnostics.push(
    diagnostic(
      "error",
      "TCSUBJECT_CANDIDATE_SCOPE_EXCLUDED",
      `scope excludes candidate object${names.length === 1 ? "" : "s"}: ${names.join(", ")}. Semantic test runs must include every object from candidateSourcePath.`,
    ),
  );
}

function applyRuntimeOmissions(
  selected: TcGenObject[],
  diagnostics: Diagnostic[],
  runtimeOptions: NormalizeRuntimeOptions,
): { objects: Set<string>; names: string[]; affectsPartialStatus: boolean } {
  const omitted = new Set<string>();
  const names: string[] = [];
  let affectsPartialStatus = false;
  if (!runtimeOptions.omitObject)
    return { objects: omitted, names, affectsPartialStatus };

  for (const object of selected) {
    const decision = runtimeOptions.omitObject(object);
    if (!decision) continue;
    omitted.add(object.qualifiedName.toLowerCase());
    names.push(object.qualifiedName);
    affectsPartialStatus =
      affectsPartialStatus || decision.affectsStatus !== false;
    diagnostics.push(
      diagnostic(decision.severity ?? "info", decision.code, decision.message, {
        blocking: false,
        object: object.qualifiedName,
        original: object.sourceSpan,
        ruleId: decision.ruleId,
      }),
    );
  }

  return { objects: omitted, names, affectsPartialStatus };
}

function validateRequestSources(
  sources: Array<{ path: string; content: string }>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (sources.length === 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "SANDBOX_EMPTY_SOURCES",
        "At least one inline source is required.",
      ),
    );
  }
  if (sources.length > 100) {
    diagnostics.push(
      diagnostic(
        "error",
        "SANDBOX_TOO_MANY_SOURCES",
        "At most 100 source files are accepted.",
      ),
    );
  }
  const totalBytes = Buffer.byteLength(
    sources.map((source) => source.content).join("\n"),
    "utf8",
  );
  if (totalBytes > 5 * 1024 * 1024) {
    diagnostics.push(
      diagnostic(
        "error",
        "SANDBOX_PAYLOAD_TOO_LARGE",
        "Total source payload exceeds 5 MB.",
      ),
    );
  }
  for (const source of sources) {
    const path = source.path ?? "";
    if (
      !path ||
      /^[A-Za-z]:/.test(path) ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      path.includes("..") ||
      path.includes("\0")
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "SANDBOX_INVALID_SOURCE_PATH",
          `Source path '${path}' must be a safe relative path.`,
          {
            original: { path, startLine: 1, endLine: 1 },
          },
        ),
      );
    }
  }
  return diagnostics;
}

function selectObjects(
  objects: TcGenObject[],
  scope: NormalizeRequest["scope"],
  diagnostics: Diagnostic[],
  strict: boolean,
): TcGenObject[] {
  if (!scope || scope.mode === "all") return [...objects];
  const requested = new Set(
    [...(scope.entrypoints ?? []), ...(scope.additionalSymbols ?? [])].map(
      (item) => item.toLowerCase(),
    ),
  );
  for (const name of requested) {
    if (
      !objects.some(
        (object) =>
          object.qualifiedName.toLowerCase() === name ||
          object.name.toLowerCase() === name,
      )
    ) {
      diagnostics.push(
        diagnostic(
          strict ? "error" : "warning",
          "TCRESOLVE_ENTRYPOINT_NOT_FOUND",
          `Entrypoint '${name}' was not found.`,
          { blocking: strict },
        ),
      );
    }
  }
  return objects.filter(
    (object) =>
      requested.has(object.qualifiedName.toLowerCase()) ||
      requested.has(object.name.toLowerCase()) ||
      (object.ownerName && requested.has(object.ownerName.toLowerCase())),
  );
}

function analyzeCompatibility(
  objects: TcGenObject[],
  diagnostics: Diagnostic[],
  strict: boolean,
): void {
  const ownerNames = new Set(
    objects
      .filter((object) => !object.ownerName)
      .map((object) => object.qualifiedName.toLowerCase()),
  );
  for (const object of objects) {
    if (object.ownerName && !ownerNames.has(object.ownerName.toLowerCase())) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCRESOLVE_MISSING_OWNER",
          `Owner '${object.ownerName}' is missing for '${object.qualifiedName}'.`,
          {
            object: object.qualifiedName,
            original: object.sourceSpan,
          },
        ),
      );
    }
    if (
      object.implementationLanguage !== "ST" &&
      object.implementationLanguage !== "unknown"
    ) {
      diagnostics.push(
        diagnostic(
          strict ? "error" : "warning",
          "TCCOMPAT_LANGUAGE_UNSUPPORTED",
          `${object.implementationLanguage} implementation '${object.qualifiedName}' is not supported in v0.1.`,
          {
            blocking: strict,
            object: object.qualifiedName,
            original: object.sourceSpan,
          },
        ),
      );
    }
    if (object.kind === "action" || object.kind === "transition") {
      diagnostics.push(
        diagnostic(
          "error",
          "TCCOMPAT_ACTION_TRANSITION_UNSUPPORTED",
          `${object.kind} '${object.qualifiedName}' is not supported by the v0.1 STruC++ profile.`,
          {
            object: object.qualifiedName,
            original: object.sourceSpan,
          },
        ),
      );
    }
    if (
      object.kind === "type" &&
      /\bUNION\b/i.test(
        `${object.declarationText}\n${object.implementationText}`,
      )
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCCOMPAT_UNION_UNSUPPORTED",
          `UNION type '${object.qualifiedName}' is not supported in v0.1.`,
          { object: object.qualifiedName, original: object.sourceSpan },
        ),
      );
    }
    if (
      object.kind === "program" &&
      (object.extendsType ||
        object.implementsTypes.length > 0 ||
        hasProgramChild(objects, object))
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCCOMPAT_PROGRAM_OOP_UNSUPPORTED",
          `PROGRAM '${object.qualifiedName}' uses OOP clauses or children not supported by the v0.1 profile.`,
          { object: object.qualifiedName, original: object.sourceSpan },
        ),
      );
    }
    if (hasUnknownPragma(object)) {
      diagnostics.push(
        diagnostic(
          strict ? "error" : "warning",
          "TCCOMPAT_UNKNOWN_PRAGMA",
          `Unknown pragma was stripped from '${object.qualifiedName}'.`,
          {
            blocking: strict,
            object: object.qualifiedName,
            original: object.sourceSpan,
            ruleId: "StripTwinCatMetadata",
          },
        ),
      );
    }
  }
}

function hasUnknownPragma(object: TcGenObject): boolean {
  return `${object.declarationText}\n${object.implementationText}`
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return (
        /^\{.*\}$/.test(trimmed) &&
        !/^\{attribute\s+'[^']+'.*\}$/i.test(trimmed)
      );
    });
}

function hasProgramChild(objects: TcGenObject[], object: TcGenObject): boolean {
  return objects.some(
    (item) =>
      item.ownerName?.toLowerCase() === object.qualifiedName.toLowerCase() &&
      (item.kind === "method" || item.kind === "property"),
  );
}

function buildSymbolMap(
  objects: TcGenObject[],
  diagnostics: Diagnostic[],
): Map<string, string> {
  const map = new Map<string, string>();
  const generated = new Map<string, string>();
  for (const object of objects) {
    if (object.kind !== "gvl" && object.kind !== "parameterList") continue;
    for (const variable of parseVariableDeclarations(object.declarationText)) {
      const original = `${object.name}.${variable}`;
      const flattened = `${object.name}__${variable}`;
      const collision = generated.get(flattened.toLowerCase());
      if (collision && collision !== original) {
        diagnostics.push(
          diagnostic(
            "error",
            "TCNORM_GLOBAL_FLATTEN_COLLISION",
            `Flattened global symbol '${flattened}' collides for '${collision}' and '${original}'.`,
            {
              original: object.sourceSpan,
              object: object.qualifiedName,
              ruleId: "NormalizeGlobalLists",
            },
          ),
        );
      }
      map.set(original, flattened);
      generated.set(flattened.toLowerCase(), original);
    }
  }
  return map;
}

function emitNormalized(
  objects: TcGenObject[],
  symbolMap: Map<string, string>,
  diagnostics: Diagnostic[],
  rewrites: RewriteRecord[],
  strict: boolean,
  runtimeReplacements: Map<string, ReplaceObjectDecision>,
): {
  files: NormalizedFile[];
  included: string[];
  includedIds: string[];
  omitted: string[];
  sourceMap: NormalizedSourceMapEntry[];
} {
  const childrenByOwner = new Map<string, TcGenObject[]>();
  for (const object of objects) {
    if (!object.ownerName) continue;
    const children = childrenByOwner.get(object.ownerName.toLowerCase()) ?? [];
    children.push(object);
    childrenByOwner.set(object.ownerName.toLowerCase(), children);
  }

  const chunks: string[] = [];
  const included: string[] = [];
  const includedIds: string[] = [];
  const omitted: string[] = [];
  const sourceMap: NormalizedSourceMapEntry[] = [];
  for (const object of objects) {
    if (object.ownerName) continue;
    if (object.kind === "visualization") {
      omitted.push(object.qualifiedName);
      continue;
    }
    if (hasBlockingDiagnostic(diagnostics, object)) {
      omitted.push(
        object.qualifiedName,
        ...(childrenByOwner.get(object.qualifiedName.toLowerCase()) ?? []).map(
          (child) => child.qualifiedName,
        ),
      );
      continue;
    }
    const runtimeReplacement = runtimeReplacements.get(
      object.qualifiedName.toLowerCase(),
    );
    if (runtimeReplacement !== undefined) {
      pushChunk(
        chunks,
        sourceMap,
        runtimeReplacement.content.trimEnd(),
        object,
        runtimeReplacement.sourceKind,
      );
      included.push(object.qualifiedName);
      includedIds.push(object.id);
      omitted.push(
        ...(childrenByOwner.get(object.qualifiedName.toLowerCase()) ?? []).map(
          (child) => child.qualifiedName,
        ),
      );
      continue;
    }
    if (object.kind === "gvl" || object.kind === "parameterList") {
      const emitted = emitGlobalObject(
        object,
        symbolMap,
        diagnostics,
        rewrites,
        strict,
      );
      if (emitted) {
        pushChunk(chunks, sourceMap, emitted, object);
        included.push(object.qualifiedName);
        includedIds.push(object.id);
      } else {
        omitted.push(object.qualifiedName);
      }
      continue;
    }

    const children =
      childrenByOwner.get(object.qualifiedName.toLowerCase()) ?? [];
    const declaration = normalizeDeclaration(
      object,
      diagnostics,
      rewrites,
      strict,
    );
    const emittedChildren = children.filter(
      (child) =>
        (child.kind === "method" || child.kind === "property") &&
        !hasBlockingDiagnostic(diagnostics, child),
    );
    const nestedChildren = emittedChildren
      .map((child) =>
        normalizeChild(child, symbolMap, diagnostics, rewrites, strict),
      )
      .join("\n\n");
    const emittedChildIds = new Set(emittedChildren.map((child) => child.id));
    omitted.push(
      ...children
        .filter((child) => !emittedChildIds.has(child.id))
        .map((child) => child.qualifiedName),
    );
    const implementation = rewriteObjectText(
      object,
      object.implementationText,
      symbolMap,
      rewrites,
      "NormalizeGlobalLists",
    );
    const parts = [declaration, nestedChildren, implementation].filter((part) =>
      part.trim(),
    );
    pushChunk(
      chunks,
      sourceMap,
      `${parts.join("\n\n")}\n${terminatorFor(object.kind)}`,
      object,
    );
    included.push(
      object.qualifiedName,
      ...emittedChildren.map((child) => child.qualifiedName),
    );
    includedIds.push(object.id, ...emittedChildren.map((child) => child.id));
  }

  return {
    files:
      chunks.length > 0
        ? [{ path: "normalized.st", content: chunks.join("\n\n") + "\n" }]
        : [],
    included,
    includedIds,
    omitted,
    sourceMap,
  };
}

function pushChunk(
  chunks: string[],
  sourceMap: NormalizedSourceMapEntry[],
  content: string,
  object: TcGenObject,
  sourceKind?: NormalizedSourceMapEntry["sourceKind"],
): void {
  const previous = sourceMap[sourceMap.length - 1];
  const generatedStartLine = previous ? previous.generatedEndLine + 2 : 1;
  const generatedEndLine = generatedStartLine + lineCount(content) - 1;
  chunks.push(content);
  sourceMap.push({
    generatedPath: "normalized.st",
    generatedStartLine,
    generatedEndLine,
    original: { ...object.sourceSpan },
    object: object.qualifiedName,
    sourceKind:
      sourceKind ??
      (isFrameworkTestObject(object) ? "generated_test_harness" : "candidate"),
  });
}

function lineCount(value: string): number {
  return value.split(/\r?\n/).length;
}

function isFrameworkTestObject(object: TcGenObject): boolean {
  return (
    /^FB_Test_/i.test(object.name) ||
    object.extendsType?.toLowerCase() === "fb_testcasebase"
  );
}

function normalizeDeclaration(
  object: TcGenObject,
  diagnostics: Diagnostic[],
  rewrites: RewriteRecord[],
  strict: boolean,
): string {
  let text = object.declarationText;
  if (object.kind === "functionBlock") {
    const originalFirst = firstLine(text);
    const rewrittenFirst = normalizeFunctionBlockHeader(
      originalFirst,
      object,
      diagnostics,
    );
    if (rewrittenFirst !== originalFirst) {
      text = text.replace(originalFirst, rewrittenFirst);
      diagnostics.push(
        diagnostic(
          "info",
          "TCNORM_FB_HEADER_REWRITTEN",
          `Function block header '${object.qualifiedName}' was normalized for STruC++.`,
          {
            blocking: false,
            object: object.qualifiedName,
            original: object.sourceSpan,
            ruleId: "NormalizePouHeaders",
          },
        ),
      );
      addRewrite(
        rewrites,
        "NormalizePouHeaders",
        object,
        originalFirst,
        rewrittenFirst,
      );
    }
  }
  if (object.kind === "function" && /\bVAR_STAT\b/i.test(text)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCCOMPAT_FUNCTION_VAR_STAT_UNSUPPORTED",
        `FUNCTION '${object.qualifiedName}' uses VAR_STAT, which is blocked in v0.1.`,
        { object: object.qualifiedName, original: object.sourceSpan },
      ),
    );
  }
  if (/\bVAR_CONFIG\b/i.test(text)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCCOMPAT_VAR_CONFIG_UNSUPPORTED",
        `'${object.qualifiedName}' uses VAR_CONFIG, which is blocked in v0.1.`,
        { object: object.qualifiedName, original: object.sourceSpan },
      ),
    );
  }
  if (
    (object.kind === "functionBlock" || object.kind === "program") &&
    /\bVAR_STAT\b/i.test(text)
  ) {
    const rewritten = text.replace(/\bVAR_STAT\b/gi, "VAR");
    diagnostics.push(
      diagnostic(
        "warning",
        "TCNORM_VAR_STAT_TO_VAR",
        `VAR_STAT in '${object.qualifiedName}' was mapped to VAR for offline execution.`,
        {
          blocking: false,
          object: object.qualifiedName,
          original: object.sourceSpan,
          ruleId: "NormalizeVariableSections",
        },
      ),
    );
    addRewrite(rewrites, "NormalizeVariableSections", object, text, rewritten);
    text = rewritten;
  }
  return stripPragmas(text, object, diagnostics, rewrites, strict);
}

function normalizeFunctionBlockHeader(
  line: string,
  object: TcGenObject,
  diagnostics: Diagnostic[],
): string {
  const match = /^FUNCTION_BLOCK\s+(.+?)\s*$/i.exec(line);
  if (!match) return line;
  const tokens = match[1].trim().split(/\s+/);
  const modifiers: string[] = [];
  while (
    tokens.length > 0 &&
    /^(PUBLIC|INTERNAL|ABSTRACT|FINAL)$/i.test(tokens[0])
  ) {
    modifiers.push(tokens.shift()!.toUpperCase());
  }
  const name = tokens.shift();
  if (!name) return line;
  if (modifiers.includes("INTERNAL")) {
    diagnostics.push(
      diagnostic(
        "warning",
        "TCNORM_ACCESS_INTERNAL_WIDENED",
        `INTERNAL function block '${object.qualifiedName}' is widened in the offline sandbox.`,
        {
          blocking: false,
          object: object.qualifiedName,
          original: object.sourceSpan,
          ruleId: "NormalizePouHeaders",
        },
      ),
    );
  }
  const kept = modifiers.filter(
    (modifier) => modifier !== "PUBLIC" && modifier !== "INTERNAL",
  );
  return ["FUNCTION_BLOCK", ...kept, name, ...tokens].join(" ");
}

function normalizeChild(
  child: TcGenObject,
  symbolMap: Map<string, string>,
  diagnostics: Diagnostic[],
  rewrites: RewriteRecord[],
  strict: boolean,
): string {
  let text = child.declarationText;
  const originalDeclaration = text;
  if (child.ownerName) {
    addRewrite(
      rewrites,
      "NormalizeChildObjects",
      child,
      child.qualifiedName,
      child.name,
    );
  }
  if (child.access === "internal") {
    text = text
      .replace(/\bMETHOD\s+INTERNAL\b/i, "METHOD PUBLIC")
      .replace(/\bPROPERTY\s+INTERNAL\b/i, "PROPERTY PUBLIC");
    diagnostics.push(
      diagnostic(
        "warning",
        "TCNORM_ACCESS_INTERNAL_WIDENED",
        `INTERNAL child '${child.qualifiedName}' is widened in the offline sandbox.`,
        {
          blocking: false,
          object: child.qualifiedName,
          original: child.sourceSpan,
          ruleId: "NormalizeChildObjects",
        },
      ),
    );
  }
  if (/\bVAR_STAT\b/i.test(text)) {
    const rewritten = text.replace(/\bVAR_STAT\b/gi, "VAR_INST");
    diagnostics.push(
      diagnostic(
        "warning",
        "TCNORM_METHOD_VAR_STAT_TO_VAR_INST",
        `VAR_STAT in '${child.qualifiedName}' was mapped to VAR_INST.`,
        {
          blocking: false,
          object: child.qualifiedName,
          original: child.sourceSpan,
          ruleId: "NormalizeVariableSections",
        },
      ),
    );
    addRewrite(rewrites, "NormalizeVariableSections", child, text, rewritten);
    text = rewritten;
  }
  if (text !== originalDeclaration) {
    addRewrite(
      rewrites,
      "NormalizeChildObjects",
      child,
      originalDeclaration,
      text,
    );
  }
  const returnAssignment = new Map(symbolMap);
  if (child.ownerName)
    returnAssignment.set(`${child.ownerName}.${child.name}`, child.name);
  const implementation = rewriteObjectText(
    child,
    child.implementationText,
    returnAssignment,
    rewrites,
    "NormalizeChildObjects",
  );
  return [
    stripPragmas(text, child, diagnostics, rewrites, strict),
    implementation,
    terminatorFor(child.kind),
  ]
    .filter((part) => part.trim())
    .join("\n");
}

function emitGlobalObject(
  object: TcGenObject,
  symbolMap: Map<string, string>,
  diagnostics: Diagnostic[],
  rewrites: RewriteRecord[],
  strict: boolean,
): string | undefined {
  if (
    object.kind === "parameterList" &&
    !/\bVAR_GLOBAL\s+CONSTANT\b/i.test(object.declarationText)
  ) {
    diagnostics.push(
      diagnostic(
        strict ? "error" : "warning",
        "TCCOMPAT_PARAMETER_LIST_NON_CONSTANT",
        `PARAMETER_LIST '${object.qualifiedName}' must be VAR_GLOBAL CONSTANT in v0.1.`,
        {
          blocking: strict,
          object: object.qualifiedName,
          original: object.sourceSpan,
        },
      ),
    );
    if (strict) return undefined;
  }
  let text = object.declarationText.replace(
    /^GVL\s+[A-Za-z_][A-Za-z0-9_]*\s*\n?/i,
    "",
  );
  text = text.replace(/^PARAMETER_LIST\s+[A-Za-z_][A-Za-z0-9_]*\s*\n?/i, "");
  text = text.replace(/\n?END_(?:GVL|PARAMETER_LIST)\s*$/i, "");
  const originalText = text;
  for (const [original, generated] of symbolMap) {
    if (!original.startsWith(`${object.name}.`)) continue;
    const variable = original.split(".")[1];
    text = text.replace(
      new RegExp(
        `\\b${escapeRegex(variable)}\\b(?=\\s*(?:AT\\s+%\\S+\\s*)?:)`,
        "g",
      ),
      generated,
    );
  }
  if (text !== originalText) {
    addRewrite(
      rewrites,
      object.kind === "parameterList"
        ? "NormalizeParameterLists"
        : "NormalizeGlobalLists",
      object,
      originalText,
      text,
    );
  }
  return stripPragmas(text.trimEnd(), object, diagnostics, rewrites, strict);
}

function stripPragmas(
  text: string,
  object: TcGenObject,
  diagnostics: Diagnostic[],
  rewrites: RewriteRecord[],
  strict: boolean,
): string {
  const lines = text.split("\n");
  const retained: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\{attribute\s+'[^']+'.*\}$/i.test(trimmed)) {
      diagnostics.push(
        diagnostic(
          "warning",
          "TCNORM_TWINCAT_ATTRIBUTE_STRIPPED",
          `TwinCAT attribute was stripped from '${object.qualifiedName}'.`,
          {
            blocking: false,
            object: object.qualifiedName,
            original: object.sourceSpan,
            ruleId: "StripTwinCatMetadata",
          },
        ),
      );
      addRewrite(rewrites, "StripTwinCatMetadata", object, line, "");
      continue;
    }
    if (/^\{.*\}$/.test(trimmed)) {
      diagnostics.push(
        diagnostic(
          strict ? "error" : "warning",
          "TCCOMPAT_UNKNOWN_PRAGMA",
          `Unknown pragma was stripped from '${object.qualifiedName}'.`,
          {
            blocking: strict,
            object: object.qualifiedName,
            original: object.sourceSpan,
            ruleId: "StripTwinCatMetadata",
          },
        ),
      );
      addRewrite(rewrites, "StripTwinCatMetadata", object, line, "");
      continue;
    }
    retained.push(line);
  }
  return retained.join("\n").trimEnd();
}

function rewriteObjectText(
  object: TcGenObject,
  text: string,
  replacements: Map<string, string>,
  rewrites: RewriteRecord[],
  ruleId: string,
): string {
  const rewritten = rewriteIdentifiersOutsideTrivia(text, replacements);
  if (rewritten !== text) {
    addRewrite(rewrites, ruleId, object, text, rewritten);
  }
  return rewritten;
}

function parseVariableDeclarations(text: string): string[] {
  const variables: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:AT\s+%\S+\s*)?:/.exec(
      line,
    );
    if (match) variables.push(match[1]);
  }
  return variables;
}

function hasBlockingDiagnostic(
  diagnostics: Diagnostic[],
  object: TcGenObject,
): boolean {
  return diagnostics.some(
    (item) => item.blocking && item.object === object.qualifiedName,
  );
}

function terminatorFor(kind: TcGenObject["kind"]): string {
  switch (kind) {
    case "type":
      return "END_TYPE";
    case "function":
      return "END_FUNCTION";
    case "interface":
      return "END_INTERFACE";
    case "functionBlock":
      return "END_FUNCTION_BLOCK";
    case "program":
      return "END_PROGRAM";
    case "method":
      return "END_METHOD";
    case "property":
      return "END_PROPERTY";
    default:
      return "";
  }
}

function addRewrite(
  rewrites: RewriteRecord[],
  ruleId: string,
  object: TcGenObject,
  originalText: string,
  generatedText: string,
): void {
  if (originalText === generatedText) return;
  rewrites.push({
    ruleId,
    originalText,
    generatedText,
    sourceSpan: object.sourceSpan,
    generatedSpan: object.sourceSpan,
  });
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
