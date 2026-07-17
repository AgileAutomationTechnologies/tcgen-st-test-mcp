import { createHash } from "node:crypto";
import {
  Diagnostic,
  DependencySimulation,
  FrameworkAssertionEvidence,
  FrameworkExecutionContract,
  FrameworkTestConfig,
  FrameworkTargetCoverage,
  NormalizedFile,
  SourceFile,
  TcGenObject,
  diagnostic
} from "../domain/models.js";
import { NormalizeResult, OmitObjectDecision, ReplaceObjectDecision } from "../normalizer/TcGenToStrucppNormalizer.js";
import {
  isFrameworkRunnerProgram,
  validateFrameworkTargetCoverage
} from "./FrameworkTargetCoverageValidator.js";
import {
  FRAMEWORK_EXECUTION_CONTRACT,
  validateFrameworkExecutionContract
} from "./FrameworkExecutionContract.js";
import {
  frameworkAssertionCheckpointDiagnostics,
  withFrameworkAssertionCheckpoints
} from "./FrameworkAssertionEvidence.js";

// The offline adapter has no TwinCAT task clock. Advance a deterministic
// one-millisecond task interval before each resumed execute scan so IEC timers
// observe the same passage of time that they would between PLC task cycles.
export const FRAMEWORK_SCAN_TIME_NANOSECONDS = 1_000_000;

export interface FrameworkTestFile {
  path: string;
  content: string;
  diagnostics: Diagnostic[];
  hash: string;
  sourceFiles: NormalizedFile[];
  mode: "framework";
  discoveredFrameworkTests: string[];
  selectedFrameworkTests: string[];
  generatedTestNames: string[];
  executionTestNames: string[];
  coveredExecutableObjects: string[];
  frameworkTargetCoverage: FrameworkTargetCoverage[];
  assertions: FrameworkAssertionEvidence[];
  frameworkTestFiles: SourceFile[];
  executionContract?: FrameworkExecutionContract;
}

const frameworkInfrastructure = new Set([
  "pl_testconfig",
  "e_assertionkind",
  "e_runnerstate",
  "e_teststate",
  "st_testassertion",
  "st_testcaseresult",
  "gvl_testresults",
  "i_testcase",
  "fb_testcasebase",
  "fb_testrunner"
]);

export function omitFrameworkInfrastructure(object: TcGenObject): OmitObjectDecision | undefined {
  const owner = object.ownerName?.toLowerCase();
  if (owner && frameworkInfrastructure.has(owner)) {
    return frameworkCoreDecision(object);
  }

  const name = object.qualifiedName.toLowerCase();
  if (frameworkInfrastructure.has(name)) {
    return frameworkCoreDecision(object);
  }

  return undefined;
}

export function replaceFrameworkRunnerProgram(object: TcGenObject): ReplaceObjectDecision | undefined {
  if (object.kind !== "program" || !isFrameworkRunnerProgram(object)) return undefined;
  const marker = "_tcgenOfflineFrameworkRegistrationValidated";
  return {
    content: [
      `PROGRAM ${object.name}`,
      "VAR",
      `    ${marker} : BOOL := TRUE;`,
      "END_VAR",
      `${marker} := TRUE;`,
      "END_PROGRAM"
    ].join("\n"),
    code: "TCFRAMEWORK_RUNNER_PROGRAM_REWRITTEN",
    message:
      `Framework runner PROGRAM '${object.qualifiedName}' was structurally validated through FB_TestRunner registration and replaced by a compiled offline registration surrogate; generated wrappers execute the concrete tests directly.`,
    severity: "info",
    ruleId: "ApplyOfflineFrameworkRunnerSurrogate",
    sourceKind: "generated_test_harness"
  };
}

export class FrameworkTestBuilder {
  generate(
    normalized: NormalizeResult,
    config: FrameworkTestConfig | undefined,
    submittedSources: SourceFile[],
    dependencySimulations: DependencySimulation[] | undefined = undefined
  ): FrameworkTestFile {
    const diagnostics: Diagnostic[] = [];
    if (!isFrameworkConfig(config)) {
      diagnostics.push(diagnostic("error", "TCFRAMEWORK_MODE_UNSUPPORTED", "frameworkTest.mode must be 'tcgen-test-framework'."));
      return emptyFrameworkTest(diagnostics);
    }

    const candidates = discoverTestFunctionBlocks(normalized.document.objects);
    const selected = selectTestFunctionBlocks(candidates, config.testFunctionBlocks, diagnostics);
    const targetCoverage = validateFrameworkTargetCoverage(
      normalized,
      selected,
      config.targetMappings,
      submittedSources
    );
    const assertions = withFrameworkAssertionCheckpoints(targetCoverage.assertions);
    diagnostics.push(...targetCoverage.diagnostics);
    diagnostics.push(...frameworkAssertionCheckpointDiagnostics(assertions));
    const simulations = validateDependencySimulations(
      dependencySimulations,
      selected.map(testBlock => testBlock.name),
      diagnostics
    );
    diagnostics.push(...validateFrameworkExecutionContract(
      config,
      selected,
      normalized.document.objects,
      submittedSources
    ));
    diagnostics.push(
      diagnostic("info", "TCFRAMEWORK_SHIM_APPLIED", "Using the offline STruC++-compatible TcGen test-framework shim.", {
        blocking: false,
        ruleId: "ApplyOfflineFrameworkShim"
      })
    );

    if (diagnostics.some(item => item.blocking)) {
      return emptyFrameworkTest(
        diagnostics,
        candidates.map(testBlock => testBlock.name),
        selected.map(testBlock => testBlock.name),
        targetCoverage.coverage,
        assertions,
        targetCoverage.frameworkTestFiles,
        config.executionContract === FRAMEWORK_EXECUTION_CONTRACT
          ? FRAMEWORK_EXECUTION_CONTRACT
          : undefined
      );
    }

    const maxScans = clampMaxScans(config.maxScans);
    const ledgerCapacity = assertionLedgerCapacity(assertions, maxScans);
    if (ledgerCapacity > 10_000) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_ASSERTION_LEDGER_CAPACITY_EXCEEDED",
          `The exact Framework test requires a worst-case assertion ledger capacity of ${ledgerCapacity}, above the qualified limit of 10000. Reduce frameworkTest.maxScans or split the test into smaller independent test FBs.`
        )
      );
      return emptyFrameworkTest(
        diagnostics,
        candidates.map(testBlock => testBlock.name),
        selected.map(testBlock => testBlock.name),
        targetCoverage.coverage,
        assertions,
        targetCoverage.frameworkTestFiles,
        FRAMEWORK_EXECUTION_CONTRACT
      );
    }
    const wrappers = emitWrapperTests(selected, maxScans, assertions, simulations);
    const content = wrappers.content;
    return {
      path: "semantic_framework_tests.st",
      content,
      diagnostics,
      hash: sha256(content),
      sourceFiles: [{
        path: "tcgen_framework_shim.st",
        content: frameworkShim(ledgerCapacity, assertions)
      }],
      mode: "framework",
      discoveredFrameworkTests: candidates.map(testBlock => testBlock.name),
      selectedFrameworkTests: selected.map(testBlock => testBlock.name),
      generatedTestNames: wrappers.generatedTestNames,
      executionTestNames: wrappers.executionTestNames,
      coveredExecutableObjects: selected.map(testBlock => testBlock.name),
      frameworkTargetCoverage: targetCoverage.coverage,
      assertions,
      frameworkTestFiles: targetCoverage.frameworkTestFiles,
      executionContract: FRAMEWORK_EXECUTION_CONTRACT
    };
  }
}

function frameworkCoreDecision(object: TcGenObject): OmitObjectDecision {
  return {
    code: "TCFRAMEWORK_CORE_REPLACED",
    message: `Framework object '${object.qualifiedName}' was replaced by the offline STruC++ compatibility shim.`,
    severity: "info",
    ruleId: "ApplyOfflineFrameworkShim",
    affectsStatus: false
  };
}

function emptyFrameworkTest(
  diagnostics: Diagnostic[],
  discoveredFrameworkTests: string[] = [],
  selectedFrameworkTests: string[] = [],
  frameworkTargetCoverage: FrameworkTargetCoverage[] = [],
  assertions: FrameworkAssertionEvidence[] = [],
  frameworkTestFiles: SourceFile[] = [],
  executionContract?: FrameworkExecutionContract
): FrameworkTestFile {
  return {
    path: "semantic_framework_tests.st",
    content: "",
    diagnostics,
    hash: "",
    sourceFiles: [],
    mode: "framework",
    discoveredFrameworkTests,
    selectedFrameworkTests,
    generatedTestNames: [],
    executionTestNames: [],
    coveredExecutableObjects: [],
    frameworkTargetCoverage,
    assertions,
    frameworkTestFiles,
    ...(executionContract ? { executionContract } : {})
  };
}

function isFrameworkConfig(value: FrameworkTestConfig | undefined): value is FrameworkTestConfig {
  return Boolean(value) && typeof value === "object" && value.mode === "tcgen-test-framework";
}

function discoverTestFunctionBlocks(objects: TcGenObject[]): TcGenObject[] {
  return objects
    .filter(
      object =>
        object.kind === "functionBlock" &&
        /^FB_Test_/i.test(object.name) &&
        object.extendsType?.toLowerCase() === "fb_testcasebase"
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function selectTestFunctionBlocks(
  candidates: TcGenObject[],
  requested: string[] | undefined,
  diagnostics: Diagnostic[]
): TcGenObject[] {
  if (!requested || requested.length === 0) {
    if (candidates.length === 0) {
      diagnostics.push(diagnostic("error", "TCFRAMEWORK_TESTS_NOT_FOUND", "No FB_Test_* EXTENDS FB_TestCaseBase framework tests were found."));
    }
    return candidates;
  }

  const byName = new Map(candidates.map(candidate => [candidate.name.toLowerCase(), candidate]));
  const selected: TcGenObject[] = [];
  const seen = new Set<string>();
  for (const item of requested) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const match = byName.get(key);
    if (!match) {
      diagnostics.push(diagnostic("error", "TCFRAMEWORK_TEST_NOT_FOUND", `Requested framework test '${name}' was not found.`));
      continue;
    }
    if (!seen.has(key)) {
      selected.push(match);
      seen.add(key);
    }
  }

  if (selected.length === 0 && !diagnostics.some(item => item.code === "TCFRAMEWORK_TEST_NOT_FOUND")) {
    diagnostics.push(diagnostic("error", "TCFRAMEWORK_TESTS_NOT_FOUND", "No framework tests were selected."));
  }
  const selectedNames = new Set(selected.map(testBlock => testBlock.name.toLowerCase()));
  const omitted = candidates.filter(testBlock => !selectedNames.has(testBlock.name.toLowerCase())).map(testBlock => testBlock.name);
  if (omitted.length > 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_TEST_SELECTION_INCOMPLETE",
        `frameworkTest.testFunctionBlocks must include every discovered submitted framework test; omitted: ${omitted.join(", ")}. Submit only the relevant test sources to focus a run.`
      )
    );
  }
  return selected;
}

function clampMaxScans(value: number | undefined): number {
  if (!Number.isInteger(value)) return 200;
  return Math.min(Math.max(value as number, 1), 10_000);
}

function assertionLedgerCapacity(
  assertions: readonly FrameworkAssertionEvidence[],
  maxScans: number
): number {
  const countByBlock = new Map<string, number>();
  for (const assertion of assertions) {
    countByBlock.set(
      assertion.testFunctionBlock,
      (countByBlock.get(assertion.testFunctionBlock) ?? 0) + 1
    );
  }
  const maxCallSites = Math.max(1, ...countByBlock.values());
  return maxCallSites * (maxScans + 1);
}

function emitWrapperTests(
  testBlocks: TcGenObject[],
  maxScans: number,
  assertions: readonly FrameworkAssertionEvidence[],
  dependencySimulations: readonly DependencySimulation[]
): { content: string; generatedTestNames: string[]; executionTestNames: string[] } {
  const lines: string[] = [];
  const generatedTestNames: string[] = [];
  const executionTestNames: string[] = [];
  for (const testBlock of testBlocks) {
    const blockAssertions = assertions.filter(
      assertion => assertion.testFunctionBlock.toLowerCase() === testBlock.name.toLowerCase()
    );
    const blockSimulations = dependencySimulations.filter(
      simulation => simulation.frameworkTest.toLowerCase() === testBlock.name.toLowerCase()
    );
    const captureName = frameworkWrapperName(testBlock.name);
    generatedTestNames.push(captureName);
    executionTestNames.push(captureName);
    lines.push(`TEST '${escapeString(captureName)}'`);
    emitFreshFrameworkExecution(lines, testBlock.name, maxScans, "capture", blockSimulations);
    lines.push("ASSERT_TRUE(GVL_TcGenAssertionLedger__diCount > 0);");
    emitFinalFrameworkResultAssertions(lines);
    lines.push("END_TEST", "");

    for (const assertion of blockAssertions) {
      const checkpointTestName = assertion.checkpointTestName ?? "";
      executionTestNames.push(checkpointTestName);
      lines.push(`TEST '${escapeString(checkpointTestName)}'`);
      emitFreshFrameworkExecution(
        lines,
        testBlock.name,
        maxScans,
        `checkpoint_${assertion.checkpointOrdinal ?? 0}`,
        blockSimulations
      );
      lines.push(
        `ASSERT_TRUE(TcGenAssertionLedgerReached('${escapeString(assertion.assertionId)}'), 'TCFRAMEWORK_ASSERTION_REACHED:${escapeString(assertion.checkpointId ?? assertion.assertionId)}');`
      );
      lines.push(
        `ASSERT_TRUE(TcGenAssertionLedgerPassed('${escapeString(assertion.assertionId)}'), 'TCFRAMEWORK_ASSERTION_PASSED:${escapeString(assertion.checkpointId ?? assertion.assertionId)}');`
      );
      emitFinalFrameworkResultAssertions(lines);
      lines.push("END_TEST", "");
    }
  }
  return {
    content: lines.join("\n").trimEnd() + "\n",
    generatedTestNames,
    executionTestNames
  };
}

function emitFreshFrameworkExecution(
  lines: string[],
  testBlockName: string,
  maxScans: number,
  suffix: string,
  dependencySimulations: readonly DependencySimulation[]
): void {
  const instance = sanitizeIdentifier(`test_${testBlockName}_${suffix}`);
  lines.push("VAR");
  lines.push(`    ${instance} : ${testBlockName};`);
  lines.push("    tcframework_execute_complete : BOOL;");
  lines.push("    result : ST_TestCaseResult;");
  lines.push("END_VAR");
  emitDependencySimulations(lines, instance, dependencySimulations);
  lines.push(`${instance}.m_xSetup(i_xTrigger := TRUE);`);
  lines.push(`${instance}.m_xSetup(i_xTrigger := FALSE);`);
  lines.push(`${instance}.m_xExecute(i_xTrigger := TRUE);`);
  lines.push(`tcframework_execute_complete := NOT ${instance}.m_xIsBusy();`);
  // ADVANCE_TIME is accepted only at TEST top level. Every checkpoint owns a
  // fresh test/CUT instance, so simultaneous failures are independently
  // observable without sharing the parent test's mutable assertion ledger.
  for (let scan = 1; scan <= maxScans; scan += 1) {
    lines.push(`ADVANCE_TIME(${FRAMEWORK_SCAN_TIME_NANOSECONDS});`);
    lines.push("IF NOT tcframework_execute_complete THEN");
    lines.push(`    ${instance}.m_xExecute(i_xTrigger := FALSE);`);
    lines.push(`    tcframework_execute_complete := NOT ${instance}.m_xIsBusy();`);
    lines.push("END_IF");
  }
  lines.push("IF tcframework_execute_complete THEN");
  lines.push(`    ${instance}.m_xTeardown(i_xTrigger := TRUE);`);
  lines.push(`    ${instance}.m_xTeardown(i_xTrigger := FALSE);`);
  lines.push("END_IF");
  lines.push(`result := ${instance}.m_stGetResult();`);
  lines.push("ASSERT_TRUE(tcframework_execute_complete);");
  lines.push("ASSERT_FALSE(GVL_TcGenAssertionLedger__xOverflow);");
}

function validateDependencySimulations(
  value: DependencySimulation[] | undefined,
  selectedTests: readonly string[],
  diagnostics: Diagnostic[]
): DependencySimulation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("error", "TCFASTTEST_SIMULATION_INVALID", "dependencySimulations must be an array."));
    return [];
  }
  const tests = new Set(selectedTests.map(name => name.toLowerCase()));
  const result: DependencySimulation[] = [];
  const seen = new Set<string>();
  for (const simulation of value) {
    const frameworkTest = String(simulation?.frameworkTest ?? "").trim();
    const kind = simulation?.kind;
    if (!tests.has(frameworkTest.toLowerCase())) {
      diagnostics.push(diagnostic("error", "TCFASTTEST_SIMULATION_TEST_UNKNOWN", `Dependency simulation references unknown Framework test '${frameworkTest}'.`));
      continue;
    }
    if (kind === "function_block") {
      const instancePath = String(simulation.instancePath ?? "").trim();
      const outputs = Array.isArray(simulation.outputs) ? simulation.outputs : [];
      if (!isMemberPath(instancePath) || outputs.length === 0 || simulation.functionName || simulation.returnValue) {
        diagnostics.push(diagnostic("error", "TCFASTTEST_FB_SIMULATION_INVALID", `Function-block simulation for '${frameworkTest}' requires one instancePath and at least one typed output.`));
        continue;
      }
      if (outputs.some(output => !isMemberPath(String(output.member ?? "")) || renderTypedValue(output) === undefined)) {
        diagnostics.push(diagnostic("error", "TCFASTTEST_FB_SIMULATION_VALUE_INVALID", `Function-block simulation '${instancePath}' contains an invalid member, IEC type, or fixed value.`));
        continue;
      }
      const key = `${frameworkTest.toLowerCase()}|fb|${instancePath.toLowerCase()}`;
      if (seen.has(key)) {
        diagnostics.push(diagnostic("error", "TCFASTTEST_SIMULATION_DUPLICATE", `Dependency simulation '${instancePath}' is duplicated for '${frameworkTest}'.`));
        continue;
      }
      seen.add(key);
      result.push(simulation);
      continue;
    }
    if (kind === "function") {
      const functionName = String(simulation.functionName ?? "").trim();
      if (!isIdentifier(functionName) || renderTypedValue(simulation.returnValue) === undefined || simulation.instancePath || simulation.outputs) {
        diagnostics.push(diagnostic("error", "TCFASTTEST_FUNCTION_SIMULATION_INVALID", `Function simulation for '${frameworkTest}' requires one functionName and one typed returnValue.`));
        continue;
      }
      const key = `${frameworkTest.toLowerCase()}|function|${functionName.toLowerCase()}`;
      if (seen.has(key)) {
        diagnostics.push(diagnostic("error", "TCFASTTEST_SIMULATION_DUPLICATE", `Function simulation '${functionName}' is duplicated for '${frameworkTest}'.`));
        continue;
      }
      seen.add(key);
      result.push(simulation);
      continue;
    }
    diagnostics.push(diagnostic("error", "TCFASTTEST_SIMULATION_KIND_INVALID", `Dependency simulation for '${frameworkTest}' has an unsupported kind.`));
  }
  return result;
}

function emitDependencySimulations(
  lines: string[],
  frameworkInstance: string,
  simulations: readonly DependencySimulation[]
): void {
  for (const simulation of simulations) {
    if (simulation.kind === "function_block") {
      const instancePath = `${frameworkInstance}.${simulation.instancePath}`;
      lines.push(`MOCK ${instancePath};`);
      for (const output of simulation.outputs ?? []) {
        lines.push(`${instancePath}.${output.member} := ${renderTypedValue(output)};`);
      }
    } else if (simulation.kind === "function") {
      lines.push(`MOCK_FUNCTION ${simulation.functionName} RETURNS ${renderTypedValue(simulation.returnValue)};`);
    }
  }
}

function renderTypedValue(value: { type: string; value: unknown } | undefined): string | undefined {
  if (!value || typeof value.type !== "string") return undefined;
  const type = value.type.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_.()]*$/.test(type)) return undefined;
  if (type === "BOOL") return typeof value.value === "boolean" ? (value.value ? "TRUE" : "FALSE") : undefined;
  if (["STRING", "WSTRING"].includes(type)) {
    return typeof value.value === "string" ? `'${value.value.replace(/'/g, "''")}'` : undefined;
  }
  if (typeof value.value === "number" && Number.isFinite(value.value)) return String(value.value);
  if (typeof value.value === "string" && /^[A-Za-z0-9_#.()+:-]+$/.test(value.value)) return value.value;
  return undefined;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value);
}

function isMemberPath(value: string): boolean {
  return isIdentifier(value) && !value.startsWith(".") && !value.endsWith(".");
}

function emitFinalFrameworkResultAssertions(lines: string[]): void {
  lines.push("ASSERT_EQ(result.eState, eTestState_Passed);");
  lines.push("ASSERT_EQ(result.eExecuteState, eTestState_Passed);");
  lines.push("ASSERT_TRUE(result.udiAssertions > 0);");
  lines.push("ASSERT_EQ(result.udiFailed, 0);");
  lines.push("ASSERT_EQ(result.udiPassed, result.udiAssertions);");
}

function frameworkWrapperName(testBlockName: string): string {
  return `framework ${testBlockName}`;
}

function frameworkShim(
  assertionLedgerCapacity: number,
  assertions: readonly FrameworkAssertionEvidence[]
): string {
  const assertionIdentityCases = assertions.map(assertion => [
    `IF i_sMessage = '${escapeString(assertion.description ?? "")}' THEN`,
    `    TcGenAssertionIdForMessage := '${escapeString(assertion.assertionId)}';`,
    "END_IF"
  ].join("\n")).join("\n");
  return `TYPE E_TestState :
(
    eTestState_Idle       := 0,
    eTestState_Running    := 1,
    eTestState_Passed     := 2,
    eTestState_Failed     := 3,
    eTestState_Error      := 4,
    eTestState_Skipped    := 5
);
END_TYPE

TYPE ST_TestCaseResult :
STRUCT
    sName          : STRING(127);
    eState         : E_TestState;
    udiAssertions  : UDINT;
    udiPassed      : UDINT;
    udiFailed      : UDINT;
    sErrorMessage  : STRING(255);
    eSetupState    : E_TestState;
    eExecuteState  : E_TestState;
    eTeardownState : E_TestState;
    uliTsStart     : ULINT;
    uliTsEnd       : ULINT;
END_STRUCT
END_TYPE

VAR_GLOBAL
    GVL_TestResults__xStartTests    : BOOL;
    GVL_TestResults__xAllDone       : BOOL;
    GVL_TestResults__xAnyFailed     : BOOL;
    GVL_TestResults__udiTotalTests  : UDINT;
    GVL_TestResults__udiPassed      : UDINT;
    GVL_TestResults__udiFailed      : UDINT;
    GVL_TestResults__udiErrors      : UDINT;
    GVL_TestResults__udiSkipped     : UDINT;
    GVL_TcGenAssertionLedger__diCount    : DINT;
    GVL_TcGenAssertionLedger__xOverflow : BOOL;
    GVL_TcGenAssertionLedger__aPassed   : ARRAY[1..${assertionLedgerCapacity}] OF BOOL;
    GVL_TcGenAssertionLedger__aMessage  : ARRAY[1..${assertionLedgerCapacity}] OF STRING(255);
    GVL_TcGenAssertionLedger__aAssertionId : ARRAY[1..${assertionLedgerCapacity}] OF STRING(80);
END_VAR

FUNCTION TcGenAssertionIdForMessage : STRING(80)
VAR_INPUT
    i_sMessage : STRING(255);
END_VAR
TcGenAssertionIdForMessage := '';
${assertionIdentityCases}
END_FUNCTION

FUNCTION TcGenAssertionLedgerReached : BOOL
VAR_INPUT
    i_sAssertionId : STRING(80);
END_VAR
VAR
    diIndex : DINT;
END_VAR
TcGenAssertionLedgerReached := FALSE;
FOR diIndex := 1 TO GVL_TcGenAssertionLedger__diCount DO
    IF GVL_TcGenAssertionLedger__aAssertionId[diIndex] = i_sAssertionId THEN
        TcGenAssertionLedgerReached := TRUE;
    END_IF
END_FOR
END_FUNCTION

FUNCTION TcGenAssertionLedgerPassed : BOOL
VAR_INPUT
    i_sAssertionId : STRING(80);
END_VAR
VAR
    diIndex : DINT;
    xReached : BOOL;
    xAllPassed : BOOL := TRUE;
END_VAR
FOR diIndex := 1 TO GVL_TcGenAssertionLedger__diCount DO
    IF GVL_TcGenAssertionLedger__aAssertionId[diIndex] = i_sAssertionId THEN
        xReached := TRUE;
        IF NOT GVL_TcGenAssertionLedger__aPassed[diIndex] THEN
            xAllPassed := FALSE;
        END_IF
    END_IF
END_FOR
TcGenAssertionLedgerPassed := xReached AND xAllPassed;
END_FUNCTION

FUNCTION_BLOCK FB_TestCaseBase
VAR
    _sTestCaseName   : STRING(127) := '';
    _eState          : E_TestState := eTestState_Idle;
    _eSetupState     : E_TestState := eTestState_Idle;
    _eExecuteState   : E_TestState := eTestState_Idle;
    _eTeardownState  : E_TestState := eTestState_Idle;
    _udiAssertions   : UDINT;
    _udiPassed       : UDINT;
    _udiFailed       : UDINT;
    _sErrorMessage   : STRING(255);
    _stResult        : ST_TestCaseResult;
    _xPhaseBusy      : BOOL;
    _uliTsStart      : ULINT;
    _uliTsEnd        : ULINT;
END_VAR

METHOD PUBLIC m_stGetResult : ST_TestCaseResult
IF (_eState = eTestState_Running) AND (_udiFailed = 0) AND (_udiAssertions > 0) AND (_eExecuteState = eTestState_Passed) THEN
    _eState := eTestState_Passed;
END_IF
_stResult.sName := _sTestCaseName;
_stResult.eState := _eState;
_stResult.udiAssertions := _udiAssertions;
_stResult.udiPassed := _udiPassed;
_stResult.udiFailed := _udiFailed;
_stResult.sErrorMessage := _sErrorMessage;
_stResult.eSetupState := _eSetupState;
_stResult.eExecuteState := _eExecuteState;
_stResult.eTeardownState := _eTeardownState;
_stResult.uliTsStart := _uliTsStart;
_stResult.uliTsEnd := _uliTsEnd;
m_stGetResult := _stResult;
END_METHOD

METHOD PUBLIC m_xSetup : BOOL
VAR_INPUT
    i_xTrigger : BOOL;
END_VAR
IF i_xTrigger THEN
    _udiAssertions := 0;
    _udiPassed := 0;
    _udiFailed := 0;
    _sErrorMessage := '';
    _eState := eTestState_Running;
    _eSetupState := eTestState_Passed;
    _eExecuteState := eTestState_Idle;
    _eTeardownState := eTestState_Idle;
    _xPhaseBusy := FALSE;
    GVL_TcGenAssertionLedger__diCount := 0;
    GVL_TcGenAssertionLedger__xOverflow := FALSE;
END_IF
m_xSetup := TRUE;
END_METHOD

METHOD PUBLIC m_xExecute : BOOL
VAR_INPUT
    i_xTrigger : BOOL;
END_VAR
IF i_xTrigger THEN
    _eExecuteState := eTestState_Passed;
    IF (_eState = eTestState_Running) AND (_udiFailed = 0) THEN
        _eState := eTestState_Passed;
    END_IF
END_IF
m_xExecute := TRUE;
END_METHOD

METHOD PUBLIC m_xTeardown : BOOL
VAR_INPUT
    i_xTrigger : BOOL;
END_VAR
IF i_xTrigger THEN
    _eTeardownState := eTestState_Passed;
END_IF
m_xTeardown := TRUE;
END_METHOD

METHOD PUBLIC m_xIsBusy : BOOL
m_xIsBusy := _xPhaseBusy;
END_METHOD

METHOD PRIVATE m_xRecordAssertion : BOOL
VAR_INPUT
    i_xPassed  : BOOL;
    i_sMessage : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
GVL_TcGenAssertionLedger__diCount := GVL_TcGenAssertionLedger__diCount + 1;
IF GVL_TcGenAssertionLedger__diCount <= ${assertionLedgerCapacity} THEN
    GVL_TcGenAssertionLedger__aPassed[GVL_TcGenAssertionLedger__diCount] := i_xPassed;
    GVL_TcGenAssertionLedger__aMessage[GVL_TcGenAssertionLedger__diCount] := i_sMessage;
    GVL_TcGenAssertionLedger__aAssertionId[GVL_TcGenAssertionLedger__diCount] := TcGenAssertionIdForMessage(i_sMessage);
ELSE
    GVL_TcGenAssertionLedger__xOverflow := TRUE;
END_IF
IF i_xPassed THEN
    _udiPassed := _udiPassed + 1;
ELSE
    _udiFailed := _udiFailed + 1;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
m_xRecordAssertion := i_xPassed;
END_METHOD

METHOD PROTECTED m_xAssertTrue : BOOL
VAR_INPUT
    i_xCondition : BOOL;
    i_sMessage   : STRING(255);
END_VAR
m_xAssertTrue := m_xRecordAssertion(
    i_xPassed := i_xCondition,
    i_sMessage := i_sMessage);
END_METHOD

METHOD PROTECTED m_xAssertFalse : BOOL
VAR_INPUT
    i_xCondition : BOOL;
    i_sMessage   : STRING(255);
END_VAR
m_xAssertFalse := m_xRecordAssertion(
    i_xPassed := NOT i_xCondition,
    i_sMessage := i_sMessage);
END_METHOD

METHOD PROTECTED m_xAssertEqualBool : BOOL
VAR_INPUT
    i_xExpected : BOOL;
    i_xActual   : BOOL;
    i_sMessage  : STRING(255);
END_VAR
m_xAssertEqualBool := m_xRecordAssertion(
    i_xPassed := i_xExpected = i_xActual,
    i_sMessage := i_sMessage);
END_METHOD

METHOD PROTECTED m_xAssertEqualDint : BOOL
VAR_INPUT
    i_nExpected : DINT;
    i_nActual   : DINT;
    i_sMessage  : STRING(255);
END_VAR
m_xAssertEqualDint := m_xRecordAssertion(
    i_xPassed := i_nExpected = i_nActual,
    i_sMessage := i_sMessage);
END_METHOD

METHOD PROTECTED m_xAssertEqualLreal : BOOL
VAR_INPUT
    i_lrExpected : LREAL;
    i_lrActual   : LREAL;
    i_sMessage   : STRING(255);
END_VAR
m_xAssertEqualLreal := m_xRecordAssertion(
    i_xPassed := i_lrExpected = i_lrActual,
    i_sMessage := i_sMessage);
END_METHOD

METHOD PROTECTED m_xAssertEqualString : BOOL
VAR_INPUT
    i_sExpected : STRING(255);
    i_sActual   : STRING(255);
    i_sMessage  : STRING(255);
END_VAR
m_xAssertEqualString := m_xRecordAssertion(
    i_xPassed := i_sExpected = i_sActual,
    i_sMessage := i_sMessage);
END_METHOD

METHOD PROTECTED m_xAssertInRange : BOOL
VAR_INPUT
    i_lrValue   : LREAL;
    i_lrLower   : LREAL;
    i_lrUpper   : LREAL;
    i_sMessage  : STRING(255);
END_VAR
m_xAssertInRange := m_xRecordAssertion(
    i_xPassed := (i_lrValue >= i_lrLower) AND (i_lrValue <= i_lrUpper),
    i_sMessage := i_sMessage);
END_METHOD
END_FUNCTION_BLOCK
`;
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function escapeString(value: string): string {
  return value.replace(/'/g, "''").replace(/\r?\n/g, "\\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
