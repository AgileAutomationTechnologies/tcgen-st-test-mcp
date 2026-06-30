export type Severity = "info" | "warning" | "error";
export type TcGenObjectKind =
  | "type"
  | "function"
  | "interface"
  | "functionBlock"
  | "program"
  | "gvl"
  | "parameterList"
  | "method"
  | "property"
  | "action"
  | "transition"
  | "visualization";

export type NormalizationStatus = "exact" | "rewritten" | "partial" | "blocked";
export type SemanticVerdict =
  | "passed"
  | "failed"
  | "partial"
  | "unsupported"
  | "compile_error"
  | "backend_error"
  | "timeout";

export interface SourceSpan {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface Diagnostic {
  severity: Severity;
  blocking: boolean;
  code: string;
  message: string;
  original?: SourceSpan;
  generated?: SourceSpan;
  object?: string;
  ruleId?: string;
  suggestion?: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface TcGenObject {
  id: string;
  kind: TcGenObjectKind;
  name: string;
  qualifiedName: string;
  ownerName?: string;
  access?: "public" | "private" | "protected" | "internal";
  modifiers: string[];
  extendsType?: string;
  implementsTypes: string[];
  implementationLanguage: "ST" | "FBD" | "LD" | "SFC" | "IL" | "unknown";
  declarationText: string;
  implementationText: string;
  attributes: string[];
  sourceSpan: SourceSpan;
  childIds: string[];
}

export interface TcGenDocument {
  schemaVersion: 1;
  files: SourceFile[];
  objects: TcGenObject[];
  diagnostics: Diagnostic[];
}

export interface RewriteRecord {
  ruleId: string;
  originalText: string;
  generatedText: string;
  sourceSpan: SourceSpan;
  generatedSpan: SourceSpan;
}

export interface NormalizedFile {
  path: string;
  content: string;
}

export interface NormalizationSummary {
  profile: "tcgen-strucpp-v1";
  status: NormalizationStatus;
  includedObjects: string[];
  omittedObjects: string[];
  blockedObjects: string[];
  symbolMap: Record<string, string>;
  rewrites: RewriteRecord[];
  diagnostics: Diagnostic[];
}

export interface NormalizeRequest {
  profile?: "tcgen-strucpp-v1";
  sources: SourceFile[];
  scope?: { mode: "all" | "entrypoints"; entrypoints?: string[]; additionalSymbols?: string[] };
  options?: { strict?: boolean; includeNormalizedSources?: boolean; autoClose?: boolean };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface TcGenTestSpec {
  schemaVersion: 1;
  name: string;
  target: {
    pouName: string;
    kind: "FUNCTION_BLOCK" | "FUNCTION" | "PROGRAM";
    instanceName?: string;
  };
  setup?: TestStep[];
  tests: Array<{ name: string; steps: TestStep[] }>;
}

export type TestStep =
  | { kind: "set"; path: string; value: JsonValue }
  | { kind: "call"; target?: string; arguments?: Record<string, JsonValue>; cycles?: number }
  | { kind: "advanceTime"; nanoseconds: number }
  | { kind: "expectEquals"; path: string; value: JsonValue; message?: string }
  | { kind: "expectNotEquals"; path: string; value: JsonValue; message?: string }
  | { kind: "expectTrue"; path: string; message?: string }
  | { kind: "expectFalse"; path: string; message?: string }
  | { kind: "expectGreaterThan"; path: string; value: number; message?: string }
  | { kind: "expectLessThan"; path: string; value: number; message?: string };

export interface BackendCheckResult {
  backend: "strucpp";
  available: boolean;
  executable?: string;
  command?: string;
  argumentsPrefix?: string[];
  cliMode?: "native" | "node";
  version?: string;
  testedVersion: string;
  gppAvailable?: boolean;
  gppExecutable?: string;
  diagnostics: Diagnostic[];
}

export interface SemanticTestReport {
  schemaVersion: 1;
  verdict: SemanticVerdict;
  backend: {
    name: "strucpp";
    version?: string;
    executable?: string;
    cliMode?: "native" | "node";
    gppExecutable?: string;
  };
  normalization: NormalizationSummary;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    compileErrors: number;
    runtimeErrors: number;
  };
  tests: Array<{ name: string; status: "passed" | "failed" | "skipped"; message?: string }>;
  diagnostics: Diagnostic[];
  artifacts?: {
    normalizedFiles?: NormalizedFile[];
    generatedTestFile?: { path: string; content: string };
    stdout?: string;
    stderr?: string;
    workspace?: string;
  };
  hashes: {
    request: string;
    normalizedSource?: string;
    testSource?: string;
  };
  qualification: string;
}

export function diagnostic(
  severity: Severity,
  code: string,
  message: string,
  options: Partial<Diagnostic> = {}
): Diagnostic {
  return {
    severity,
    code,
    message,
    blocking: severity === "error",
    ...options
  };
}
