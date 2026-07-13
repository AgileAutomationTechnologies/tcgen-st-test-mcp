import { createHash } from "node:crypto";
import {
  Diagnostic,
  FrameworkTestConfig,
  NormalizedFile,
  TcGenObject,
  diagnostic
} from "../domain/models.js";
import { NormalizeResult, OmitObjectDecision, ReplaceObjectDecision } from "../normalizer/TcGenToStrucppNormalizer.js";
import { stripTrivia } from "../normalizer/tokenRewrite.js";

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
  coveredExecutableObjects: string[];
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
    ruleId: "ApplyOfflineFrameworkRunnerSurrogate"
  };
}

function isFrameworkRunnerProgram(object: TcGenObject): boolean {
  const text = stripTrivia(`${object.declarationText}\n${object.implementationText}`);
  return /\bFB_TestRunner\b/i.test(text) && /\bm_udiRegisterTest\s*\(/i.test(text);
}

export class FrameworkTestBuilder {
  generate(normalized: NormalizeResult, config: FrameworkTestConfig | undefined): FrameworkTestFile {
    const diagnostics: Diagnostic[] = [];
    if (!isFrameworkConfig(config)) {
      diagnostics.push(diagnostic("error", "TCFRAMEWORK_MODE_UNSUPPORTED", "frameworkTest.mode must be 'tcgen-test-framework'."));
      return emptyFrameworkTest(diagnostics);
    }

    const candidates = discoverTestFunctionBlocks(normalized.document.objects);
    const selected = selectTestFunctionBlocks(candidates, config.testFunctionBlocks, diagnostics);
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
        selected.map(testBlock => testBlock.name)
      );
    }

    const maxScans = clampMaxScans(config.maxScans);
    const content = emitWrapperTests(selected, maxScans);
    return {
      path: "semantic_framework_tests.st",
      content,
      diagnostics,
      hash: sha256(content),
      sourceFiles: [{ path: "tcgen_framework_shim.st", content: frameworkShim }],
      mode: "framework",
      discoveredFrameworkTests: candidates.map(testBlock => testBlock.name),
      selectedFrameworkTests: selected.map(testBlock => testBlock.name),
      generatedTestNames: selected.map(testBlock => frameworkWrapperName(testBlock.name)),
      coveredExecutableObjects: selected.map(testBlock => testBlock.name)
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
  selectedFrameworkTests: string[] = []
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
    coveredExecutableObjects: []
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

function emitWrapperTests(testBlocks: TcGenObject[], maxScans: number): string {
  const lines: string[] = [];
  for (const testBlock of testBlocks) {
    const instance = sanitizeIdentifier(`test_${testBlock.name}`);
    lines.push(`TEST '${escapeString(frameworkWrapperName(testBlock.name))}'`);
    lines.push("VAR");
    lines.push(`    ${instance} : ${testBlock.name};`);
    lines.push("    scan : DINT;");
    lines.push("    done : BOOL;");
    lines.push("    result : ST_TestCaseResult;");
    lines.push("END_VAR");
    lines.push(`${instance}.m_xSetup(i_xTrigger := TRUE);`);
    lines.push(`${instance}.m_xSetup(i_xTrigger := FALSE);`);
    lines.push(`${instance}.m_xExecute(i_xTrigger := TRUE);`);
    lines.push(`FOR scan := 1 TO ${maxScans} DO`);
    lines.push("    IF NOT done THEN");
    lines.push(`        done := NOT ${instance}.m_xIsBusy();`);
    lines.push("    END_IF");
    lines.push("END_FOR");
    lines.push("IF done THEN");
    lines.push(`    ${instance}.m_xTeardown(i_xTrigger := TRUE);`);
    lines.push(`    ${instance}.m_xTeardown(i_xTrigger := FALSE);`);
    lines.push("END_IF");
    lines.push(`result := ${instance}.m_stGetResult();`);
    lines.push("ASSERT_TRUE(done);");
    lines.push("ASSERT_TRUE(result.udiAssertions > 0);");
    lines.push("ASSERT_EQ(result.sErrorMessage, '');");
    lines.push("ASSERT_EQ(result.udiFailed, 0);");
    lines.push("ASSERT_EQ(result.eState, eTestState_Passed);");
    lines.push("END_TEST", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function frameworkWrapperName(testBlockName: string): string {
  return `framework ${testBlockName}`;
}

const frameworkShim = `TYPE E_TestState :
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
END_VAR

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

METHOD PROTECTED m_xAssertTrue : BOOL
VAR_INPUT
    i_xCondition : BOOL;
    i_sMessage   : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF i_xCondition THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertTrue := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertTrue := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD

METHOD PROTECTED m_xAssertFalse : BOOL
VAR_INPUT
    i_xCondition : BOOL;
    i_sMessage   : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF NOT i_xCondition THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertFalse := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertFalse := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD

METHOD PROTECTED m_xAssertEqualBool : BOOL
VAR_INPUT
    i_xExpected : BOOL;
    i_xActual   : BOOL;
    i_sMessage  : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF i_xExpected = i_xActual THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertEqualBool := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertEqualBool := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD

METHOD PROTECTED m_xAssertEqualDint : BOOL
VAR_INPUT
    i_nExpected : DINT;
    i_nActual   : DINT;
    i_sMessage  : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF i_nExpected = i_nActual THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertEqualDint := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertEqualDint := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD

METHOD PROTECTED m_xAssertEqualLreal : BOOL
VAR_INPUT
    i_lrExpected : LREAL;
    i_lrActual   : LREAL;
    i_sMessage   : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF i_lrExpected = i_lrActual THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertEqualLreal := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertEqualLreal := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD

METHOD PROTECTED m_xAssertEqualString : BOOL
VAR_INPUT
    i_sExpected : STRING(255);
    i_sActual   : STRING(255);
    i_sMessage  : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF i_sExpected = i_sActual THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertEqualString := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertEqualString := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD

METHOD PROTECTED m_xAssertInRange : BOOL
VAR_INPUT
    i_lrValue   : LREAL;
    i_lrLower   : LREAL;
    i_lrUpper   : LREAL;
    i_sMessage  : STRING(255);
END_VAR
_udiAssertions := _udiAssertions + 1;
IF (i_lrValue >= i_lrLower) AND (i_lrValue <= i_lrUpper) THEN
    _udiPassed := _udiPassed + 1;
    m_xAssertInRange := TRUE;
ELSE
    _udiFailed := _udiFailed + 1;
    m_xAssertInRange := FALSE;
    IF _sErrorMessage = '' THEN
        _sErrorMessage := i_sMessage;
    END_IF
    _eState := eTestState_Failed;
END_IF
END_METHOD
END_FUNCTION_BLOCK
`;

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
