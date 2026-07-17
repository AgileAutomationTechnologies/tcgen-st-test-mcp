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
export type SemanticTestMode = "generated" | "framework";
export type FrameworkExecutionContract = "tcgen-framework-multiscan-v1";
export type SemanticArtifactRole = "framework_st" | "execution_adapter";

export interface SemanticArtifactIdentity {
  artifactId: string;
  role: SemanticArtifactRole;
  path: string;
  sha256: string;
  byteLength: number;
  primary: boolean;
  visibility: "review" | "technical";
}

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
  sourceKind?:
    "generated_test_harness" | "candidate" | "backend" | "mixed" | "unknown";
  original?: SourceSpan;
  generated?: SourceSpan;
  object?: string;
  ruleId?: string;
  suggestion?: string;
  detail?: "backend_incompatibility";
  technicalEvidence?: {
    kind: "compiler_output";
    channel: "stdout" | "stderr";
    content: string;
    sourceKind: "generated_cpp";
    generatedArtifacts: string[];
  };
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
  candidateSourcePath: string;
  sources: SourceFile[];
  projectDependencySourceSha256?: Array<{
    path: string;
    sourceSha256: string;
  }>;
  dependencySimulations?: DependencySimulation[];
  scope?: {
    mode: "all" | "entrypoints";
    entrypoints?: string[];
    additionalSymbols?: string[];
  };
  options?: {
    strict?: boolean;
    includeNormalizedSources?: boolean;
    autoClose?: boolean;
    candidateCompilePreflight?: boolean;
    executionPurpose?: "candidate_compile_preflight";
  };
}

export interface TypedSimulationValue {
  type: string;
  value: JsonValue;
}

export interface DependencySimulation {
  frameworkTest: string;
  kind: "function_block" | "function";
  instancePath?: string;
  outputs?: Array<{ member: string } & TypedSimulationValue>;
  functionName?: string;
  returnValue?: TypedSimulationValue;
}

export interface SemanticTestSubject {
  candidateSourcePath: string;
  candidateSha256?: string;
  dependencyBundleSha256?: string;
  discoveredFrameworkTests?: string[];
  selectedFrameworkTests?: string[];
  beckhoffSimulationIdentity?: string;
}

export interface BeckhoffSimulationIdentity {
  profile: "beckhoff-virtual";
  runtimeProfile: "beckhoff-virtual-v1";
  capability: "beckhoffVirtualTransparentExecutionV1";
  identity: string;
  descriptorCount: number;
  supportTypeCount: number;
  qualified: boolean;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export interface FrameworkTestConfig {
  mode: "tcgen-test-framework";
  executionContract: FrameworkExecutionContract;
  testFunctionBlocks?: string[];
  targetMappings: FrameworkTargetMapping[];
  maxScans?: number;
}

export interface FrameworkTargetMapping {
  testFunctionBlock: string;
  productionTarget: string;
  testSourcePath: string;
  testSourceSha256: string;
}

export interface FrameworkTargetCoverage extends FrameworkTargetMapping {
  assertionCount: number;
  targetReferenceCount: number;
  verified: boolean;
}

export interface FrameworkAssertionEvidence {
  assertionId: string;
  testFunctionBlock: string;
  productionTarget: string;
  assertionName: string;
  sourcePath: string;
  testSourceSha256: string;
  sourceLine: number;
  description?: string;
  targetLinked: boolean;
  checkpointId?: string;
  checkpointTestName?: string;
  checkpointOrdinal?: number;
  reached: boolean;
  startedAt?: string;
  completedAt?: string;
  status: "not_run" | "not_reached" | "passed" | "failed" | "unknown";
  executionEvidence:
    | "not_executed"
    | "parent_test_passed"
    | "backend_message"
    | "parent_test_failed"
    | "assertion_checkpoint_passed"
    | "assertion_checkpoint_failed"
    | "assertion_checkpoint_not_reached";
}

export interface FrameworkAssertionCheckpoint {
  checkpointId: string;
  assertionId: string;
  testFunctionBlock: string;
  checkpointTestName: string;
  ordinal: number;
  reached: boolean;
  startedAt?: string;
  completedAt?: string;
  status: FrameworkAssertionEvidence["status"];
}

export interface FrameworkAssertionLedger {
  contract: "tcgen-framework-assertion-ledger-v1";
  ledgerSha256: string;
  complete: boolean;
  expected: number;
  reached: number;
  passed: number;
  failed: number;
  notReached: number;
  checkpoints: FrameworkAssertionCheckpoint[];
}

export interface StandardFunctionBlockParameterContract {
  name: string;
  type: string;
  aliases: string[];
}

export interface StandardFunctionBlockContract {
  name: string;
  inputs: StandardFunctionBlockParameterContract[];
  outputs: StandardFunctionBlockParameterContract[];
  inouts: StandardFunctionBlockParameterContract[];
  dominance?: "set" | "reset";
}

export interface StandardFunctionBlockContracts {
  schemaVersion: 1;
  schema: "tcgen-iec-function-block-contracts-v1";
  contractVersion: "1.0.0";
  library: {
    name: "iec-standard-fb";
    version: "1.1.0";
    namespace: "strucpp";
  };
  sha256: string;
  payloadBytes: number;
  functionBlocks: StandardFunctionBlockContract[];
}

export type TestStep =
  | { kind: "set"; path: string; value: JsonValue }
  | {
      kind: "call";
      target?: string;
      arguments?: Record<string, JsonValue>;
      cycles?: number;
    }
  | { kind: "advanceTime"; nanoseconds: number }
  | { kind: "expectEquals"; path: string; value: JsonValue; message?: string }
  | {
      kind: "expectNotEquals";
      path: string;
      value: JsonValue;
      message?: string;
    }
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
  standardFunctionBlockContracts: StandardFunctionBlockContracts;
  standardFunctionBlockContractQualified: boolean;
  beckhoffSimulation: BeckhoffSimulationIdentity;
  diagnostics: Diagnostic[];
}

export interface SemanticTestReport {
  schemaVersion: 2;
  executionPurpose?: "candidate_compile_preflight";
  testMode: SemanticTestMode;
  verificationProfile: "isolated_semantic";
  integrationCoverage: "not_claimed";
  dependencySimulations: DependencySimulation[];
  coveredExecutableObjects: string[];
  frameworkTargetCoverage: FrameworkTargetCoverage[];
  assertions: FrameworkAssertionEvidence[];
  assertionLedger: FrameworkAssertionLedger;
  artifactIdentities?: SemanticArtifactIdentity[];
  generatedTestNames: string[];
  subject: SemanticTestSubject & {
    candidateSha256: string;
    dependencyBundleSha256: string;
  };
  verdict: SemanticVerdict;
  backend: {
    name: "strucpp";
    executionAttempted: boolean;
    version?: string;
    executable?: string;
    cliMode?: "native" | "node";
    gppExecutable?: string;
    timeout?: {
      timeoutMs: number;
      durationMs: number;
      terminationStatus: "process_tree_terminated" | "cancelled";
      owner: "framework" | "production" | "backend" | "environment" | "unknown";
      generatedTestSourceSha256?: string;
      stdoutTail: string;
      stderrTail: string;
      lastProgressPhase: string;
      checkpointSummary: {
        total: number;
        started: number;
        completed: number;
        failed: number;
        notReached: number;
      };
    };
    standardFunctionBlockContracts: StandardFunctionBlockContracts;
    standardFunctionBlockContractQualified: boolean;
    beckhoffSimulation: BeckhoffSimulationIdentity;
  };
  normalization: NormalizationSummary;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    compileErrors: number;
    runtimeErrors: number;
    timedOut: number;
    unsupported: number;
    total: number;
  };
  tests: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    message?: string;
  }>;
  diagnostics: Diagnostic[];
  artifacts?: {
    normalizedFiles?: NormalizedFile[];
    testFile?: { path: string; content: string };
    generatedTestFile?: { path: string; content: string };
    frameworkTestFiles?: SourceFile[];
    stdout?: string;
    stderr?: string;
    workspace?: string;
  };
  hashes: {
    request: string;
    normalizedSource?: string;
    testSource: string;
    beckhoffSimulationIdentity?: string;
  };
  qualification: string;
}

export function diagnostic(
  severity: Severity,
  code: string,
  message: string,
  options: Partial<Diagnostic> = {},
): Diagnostic {
  return {
    severity,
    code,
    message,
    blocking: severity === "error",
    ...options,
  };
}
