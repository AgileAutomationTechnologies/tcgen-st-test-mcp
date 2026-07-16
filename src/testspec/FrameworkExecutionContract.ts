import {
  Diagnostic,
  FrameworkExecutionContract,
  FrameworkTestConfig,
  SourceFile,
  TcGenObject,
  diagnostic
} from "../domain/models.js";
import { stripTrivia } from "../normalizer/tokenRewrite.js";

export const FRAMEWORK_EXECUTION_CONTRACT: FrameworkExecutionContract = "tcgen-framework-multiscan-v1";

export function validateFrameworkExecutionContract(
  config: FrameworkTestConfig,
  selectedTests: readonly TcGenObject[],
  allObjects: readonly TcGenObject[],
  submittedSources: readonly SourceFile[]
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (config.executionContract !== FRAMEWORK_EXECUTION_CONTRACT) {
    diagnostics.push(
      diagnostic(
        "error",
        config.executionContract ? "TCFRAMEWORK_EXECUTION_CONTRACT_UNSUPPORTED" : "TCFRAMEWORK_EXECUTION_CONTRACT_REQUIRED",
        config.executionContract
          ? `Framework execution contract '${String(config.executionContract)}' is not supported; use '${FRAMEWORK_EXECUTION_CONTRACT}'.`
          : `frameworkTest.executionContract must be '${FRAMEWORK_EXECUTION_CONTRACT}'.`
      )
    );
    return diagnostics;
  }

  for (const test of selectedTests) {
    const source = submittedSources.find(item => item.path === test.sourceSpan.path);
    const objectSource = source ? sourceSpanText(source.content, test) : `${test.declarationText}\n${test.implementationText}`;
    if (containsAnonymousInlineEnum(objectSource)) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_ANONYMOUS_ENUM_UNSUPPORTED",
          `Framework test '${test.name}' declares an anonymous inline enum state. Declare a named TwinCAT DUT or use scalar state constants so the exact test remains compatible with both TwinCAT and the pinned offline runtime.`,
          {
            sourceKind: "generated_test_harness",
            object: test.qualifiedName,
            original: { ...test.sourceSpan }
          }
        )
      );
    }

    const execute = allObjects.find(object =>
      object.kind === "method"
      && object.name.toLowerCase() === "m_xexecute"
      && object.ownerName?.toLowerCase() === test.qualifiedName.toLowerCase()
    );
    const busyObserver = allObjects.find(object =>
      object.kind === "method"
      && object.name.toLowerCase() === "m_xisbusy"
      && object.ownerName?.toLowerCase() === test.qualifiedName.toLowerCase()
    );
    if (!execute) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_EXECUTE_METHOD_REQUIRED",
          `Framework test '${test.name}' must declare m_xExecute for '${FRAMEWORK_EXECUTION_CONTRACT}'.`,
          {
            sourceKind: "generated_test_harness",
            object: test.qualifiedName,
            original: { ...test.sourceSpan }
          }
        )
      );
      continue;
    }

    const execution = validateExecuteMethod(test, execute, objectSource);
    diagnostics.push(...execution.diagnostics);
    if (execution.multiScan && !busyObserver) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCFRAMEWORK_BUSY_OBSERVER_REQUIRED",
          `Multi-scan Framework test '${test.name}' must expose m_xIsBusy as a side-effect-free observer of _xPhaseBusy.`,
          {
            sourceKind: "generated_test_harness",
            object: test.qualifiedName,
            original: { ...test.sourceSpan }
          }
        )
      );
    }
    if (busyObserver) diagnostics.push(...validateBusyObserver(test, busyObserver));
    diagnostics.push(...validateBusyOwnership(test, execute, allObjects));
  }
  return diagnostics;
}

function validateBusyObserver(test: TcGenObject, busyObserver: TcGenObject): Diagnostic[] {
  const code = stripTrivia(busyObserver.implementationText);
  const stateAssignments = [...code.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*:=/gi)]
    .map(match => match[1])
    .filter(target => target.toLowerCase() !== "m_xisbusy");
  const diagnostics: Diagnostic[] = [];
  if (stateAssignments.length > 0) diagnostics.push(
    diagnostic(
      "error",
      "TCFRAMEWORK_BUSY_OBSERVER_SIDE_EFFECT",
      `Framework test '${test.name}' mutates '${[...new Set(stateAssignments)].join(", ")}' inside m_xIsBusy. Under '${FRAMEWORK_EXECUTION_CONTRACT}', m_xIsBusy may only report state; advance work in m_xExecute(FALSE).`,
      {
        sourceKind: "generated_test_harness",
        object: busyObserver.qualifiedName,
        original: { ...busyObserver.sourceSpan }
      }
    )
  );
  if (!/\bm_xIsBusy\s*:=\s*_xPhaseBusy\s*;/i.test(code)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_BUSY_OBSERVER_INVALID",
        `Framework test '${test.name}' must implement m_xIsBusy as the side-effect-free expression 'm_xIsBusy := _xPhaseBusy;'.`,
        {
          sourceKind: "generated_test_harness",
          object: busyObserver.qualifiedName,
          original: { ...busyObserver.sourceSpan }
        }
      )
    );
  }
  return diagnostics;
}

function validateExecuteMethod(
  test: TcGenObject,
  execute: TcGenObject,
  testSource: string
): { diagnostics: Diagnostic[]; multiScan: boolean } {
  const diagnostics: Diagnostic[] = [];
  const code = stripTrivia(`${testSource}\n${execute.declarationText}\n${execute.implementationText}`);
  const options = {
    sourceKind: "generated_test_harness" as const,
    object: execute.qualifiedName,
    original: { ...execute.sourceSpan }
  };
  if (!hasTriggerInput(execute.declarationText)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_EXECUTE_TRIGGER_INPUT_REQUIRED",
        `Framework test '${test.name}' must declare VAR_INPUT i_xTrigger : BOOL on m_xExecute.`,
        options
      )
    );
  }

  const triggerFlow = parseTriggerFlow(execute.implementationText);
  if (!triggerFlow) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_TRIGGER_REQUIRED",
        `Framework test '${test.name}' must initialize m_xExecute from an IF i_xTrigger THEN branch.`,
        options
      )
    );
    return { diagnostics, multiScan: false };
  }

  const startsBusyPhase = /\b_xPhaseBusy\s*:=\s*TRUE\b/i.test(triggerFlow.trueBranch);
  const multiScan = startsBusyPhase && !triggerBranchCompletesSynchronously(triggerFlow.trueBranch);
  if (!multiScan) {
    validateSuccessfulTerminalState(test, triggerFlow.trueBranch, options, diagnostics);
    return { diagnostics, multiScan: false };
  }

  const reachableResumeSource = reachableFalseTriggerSource(triggerFlow);
  if (!/\budiStep\s*:\s*UDINT\b/i.test(code)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_STEP_REQUIRED",
        `Multi-scan Framework test '${test.name}' must declare 'udiStep : UDINT' as its deterministic execution step.`,
        options
      )
    );
  }
  if (!/\budiStep\s*:=\s*(?:0|1)\s*;/i.test(triggerFlow.trueBranch)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_STEP_INITIALIZATION_REQUIRED",
        `Multi-scan Framework test '${test.name}' must initialize udiStep in the TRUE-trigger branch.`,
        options
      )
    );
  }
  if (!/\bCASE\s+udiStep\s+OF\b/i.test(reachableResumeSource)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_CASE_REQUIRED",
        `Multi-scan Framework test '${test.name}' must advance through 'CASE udiStep OF' in its FALSE-trigger path.`,
        options
      )
    );
  }
  if (!hasStateAssignment(triggerFlow.trueBranch, "_eState", "Running")
    || !hasStateAssignment(triggerFlow.trueBranch, "_eExecuteState", "Running")) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_RUNNING_STATE_REQUIRED",
        `Multi-scan Framework test '${test.name}' must set both _eState and _eExecuteState to eTestState_Running before setting _xPhaseBusy.`,
        options
      )
    );
  }
  if (!hasDualRunningGuard(reachableResumeSource)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_RUNNING_GUARD_REQUIRED",
        `Multi-scan Framework test '${test.name}' may resume only while both _eState and _eExecuteState remain eTestState_Running.`,
        options
      )
    );
  }
  if (!containsMeaningfulResumeStatement(reachableResumeSource)) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_RESUME_REQUIRED",
        `Multi-scan Framework test '${test.name}' sets _xPhaseBusy but has no executable FALSE-trigger resume path. Initialize on TRUE and advance exactly one scan when m_xExecute(FALSE) is called while busy.`,
        options
      )
    );
  }
  if (!/\b_xPhaseBusy\s*:=\s*FALSE\b/i.test(removeStaticallyFalseBlocks(reachableResumeSource))) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_TERMINATION_REQUIRED",
        `Multi-scan Framework test '${test.name}' never clears _xPhaseBusy on a terminal path.`,
        options
      )
    );
  }
  const busyClearCount = (
    removeStaticallyFalseBlocks(reachableResumeSource).match(/\b_xPhaseBusy\s*:=\s*FALSE\b/gi) ?? []
  ).length;
  if (busyClearCount < 2) {
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_MULTISCAN_FAILURE_TERMINATION_REQUIRED",
        `Multi-scan Framework test '${test.name}' must clear _xPhaseBusy when either inherited state leaves Running as well as on its successful terminal path.`,
        options
      )
    );
  }
  validateSuccessfulTerminalState(test, reachableResumeSource, options, diagnostics);
  return { diagnostics, multiScan: true };
}

function validateSuccessfulTerminalState(
  test: TcGenObject,
  terminalSource: string,
  options: {
    sourceKind: "generated_test_harness";
    object: string;
    original: TcGenObject["sourceSpan"];
  },
  diagnostics: Diagnostic[]
): void {
  if (hasStateAssignment(terminalSource, "_eState", "Passed")
    && hasStateAssignment(terminalSource, "_eExecuteState", "Passed")) {
    if (/\b_xPhaseBusy\s*:=\s*FALSE\b/i.test(removeStaticallyFalseBlocks(terminalSource))) {
      return;
    }
    diagnostics.push(
      diagnostic(
        "error",
        "TCFRAMEWORK_TERMINAL_BUSY_CLEAR_REQUIRED",
        `Framework test '${test.name}' must clear _xPhaseBusy on its successful terminal path.`,
        options
      )
    );
    return;
  }
  diagnostics.push(
    diagnostic(
      "error",
      "TCFRAMEWORK_TERMINAL_STATES_REQUIRED",
      `Framework test '${test.name}' must set both _eState and _eExecuteState to eTestState_Passed on its successful terminal path.`,
      options
    )
  );
}

function hasStateAssignment(source: string, target: string, state: "Running" | "Passed"): boolean {
  return new RegExp(`\\b${target}\\s*:=\\s*eTestState_${state}\\b`, "i").test(
    removeStaticallyFalseBlocks(source)
  );
}

function hasDualRunningGuard(source: string): boolean {
  return /\b_eState\s*=\s*eTestState_Running\b/i.test(source)
    && /\b_eExecuteState\s*=\s*eTestState_Running\b/i.test(source);
}

function validateBusyOwnership(
  test: TcGenObject,
  execute: TcGenObject,
  allObjects: readonly TcGenObject[]
): Diagnostic[] {
  const otherAssignments = allObjects.filter(object =>
    object.ownerName?.toLowerCase() === test.qualifiedName.toLowerCase()
    && object.id !== execute.id
    && object.kind !== "functionBlock"
    && /\b_xPhaseBusy\s*:=/i.test(stripTrivia(object.implementationText))
  );
  if (otherAssignments.length === 0) return [];
  return otherAssignments.map(object => diagnostic(
    "error",
    "TCFRAMEWORK_PHASE_BUSY_OWNERSHIP",
    `Framework test '${test.name}' may assign _xPhaseBusy only inside m_xExecute; '${object.qualifiedName}' also assigns it.`,
    {
      sourceKind: "generated_test_harness",
      object: object.qualifiedName,
      original: { ...object.sourceSpan }
    }
  ));
}

type TriggerFlow = {
  trueBranch: string;
  falseBranches: Array<{ condition?: string; body: string }>;
  afterBlock: string;
};

function hasTriggerInput(declaration: string): boolean {
  const code = stripTrivia(declaration);
  return /\bVAR_INPUT\b[\s\S]*?\bi_xTrigger\s*:\s*BOOL\s*;[\s\S]*?\bEND_VAR\b/i.test(code);
}

function parseTriggerFlow(implementation: string): TriggerFlow | undefined {
  const code = stripTrivia(implementation);
  const trigger = /\bIF\s+i_xTrigger\s+THEN\b/i.exec(code);
  if (!trigger) return undefined;

  const tokens = /\bEND_IF\b|\bELSIF\b|\bELSE\b|\bIF\b/gi;
  tokens.lastIndex = trigger.index + trigger[0].length;
  let depth = 1;
  let branchStart = tokens.lastIndex;
  let trueBranch = "";
  const falseBranches: TriggerFlow["falseBranches"] = [];
  let currentCondition: string | undefined;
  for (let token = tokens.exec(code); token; token = tokens.exec(code)) {
    const keyword = token[0].toUpperCase();
    if (keyword === "IF") {
      depth += 1;
    } else if (keyword === "END_IF") {
      depth -= 1;
      if (depth === 0) {
        const body = code.slice(branchStart, token.index);
        if (currentCondition === undefined && falseBranches.length === 0) trueBranch = body;
        else falseBranches.push({ condition: currentCondition, body });
        return {
          trueBranch,
          falseBranches,
          afterBlock: code.slice(token.index + token[0].length)
        };
      }
    } else if (depth === 1 && (keyword === "ELSE" || keyword === "ELSIF")) {
      const body = code.slice(branchStart, token.index);
      if (currentCondition === undefined && falseBranches.length === 0) trueBranch = body;
      else falseBranches.push({ condition: currentCondition, body });
      if (keyword === "ELSIF") {
        const then = /\bTHEN\b/gi;
        then.lastIndex = token.index + token[0].length;
        const thenMatch = then.exec(code);
        if (!thenMatch) return undefined;
        currentCondition = code.slice(token.index + token[0].length, thenMatch.index).trim();
        branchStart = thenMatch.index + thenMatch[0].length;
        tokens.lastIndex = branchStart;
      } else {
        currentCondition = "";
        branchStart = token.index + token[0].length;
      }
    }
  }
  return undefined;
}

function triggerBranchCompletesSynchronously(trueBranch: string): boolean {
  const assignments = topLevelBusyAssignments(trueBranch);
  return assignments.length > 0 && assignments[assignments.length - 1] === false;
}

function topLevelBusyAssignments(value: string): boolean[] {
  const assignments: boolean[] = [];
  const tokens = /\bEND_(?:IF|CASE|FOR|WHILE|REPEAT)\b|\b(?:IF|CASE|FOR|WHILE|REPEAT)\b|\b_xPhaseBusy\s*:=\s*(TRUE|FALSE)\b/gi;
  let depth = 0;
  for (const token of value.matchAll(tokens)) {
    const keyword = token[0].toUpperCase();
    if (keyword.startsWith("END_")) {
      depth = Math.max(0, depth - 1);
    } else if (token[1]) {
      if (depth === 0) assignments.push(token[1].toUpperCase() === "TRUE");
    } else {
      depth += 1;
    }
  }
  return assignments;
}

function reachableFalseTriggerSource(flow: TriggerFlow): string {
  const reachableBranches = flow.falseBranches
    .filter(branch => branch.condition === "" || conditionCanRunWhenTriggerIsFalse(branch.condition ?? ""))
    .map(branch => `${branch.condition ?? ""}\n${branch.body}`);
  return [...reachableBranches, flow.afterBlock].join("\n");
}

function conditionCanRunWhenTriggerIsFalse(condition: string): boolean {
  if (!/\bi_xTrigger\b/i.test(condition)) return true;
  return /\bNOT\s+i_xTrigger\b/i.test(condition)
    || /\bi_xTrigger\s*=\s*FALSE\b/i.test(condition)
    || /\bFALSE\s*=\s*i_xTrigger\b/i.test(condition);
}

function containsMeaningfulResumeStatement(value: string): boolean {
  const reachable = removeStaticallyFalseBlocks(value)
    .replace(/\bm_xExecute\s*:=\s*(?:TRUE|FALSE)\s*;/gi, "")
    .replace(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*:=\s*\1\s*;/gi, "");
  return /\b[A-Za-z_][A-Za-z0-9_.]*\s*:=/i.test(reachable)
    || /\b[A-Za-z_][A-Za-z0-9_.]*\s*\(/i.test(reachable);
}

function removeStaticallyFalseBlocks(value: string): string {
  let code = value;
  const falseIf = /\bIF\s+(?:FALSE|0\s*=\s*1)\s+THEN\b/gi;
  for (let match = falseIf.exec(code); match; match = falseIf.exec(code)) {
    const end = matchingEndIf(code, match.index + match[0].length);
    if (end < 0) break;
    code = `${code.slice(0, match.index)} ${code.slice(end)}`;
    falseIf.lastIndex = match.index + 1;
  }
  return code;
}

function matchingEndIf(code: string, start: number): number {
  const tokens = /\bEND_IF\b|\bIF\b/gi;
  tokens.lastIndex = start;
  let depth = 1;
  for (let token = tokens.exec(code); token; token = tokens.exec(code)) {
    if (token[0].toUpperCase() === "IF") depth += 1;
    else if (--depth === 0) return token.index + token[0].length;
  }
  return -1;
}

function containsAnonymousInlineEnum(source: string): boolean {
  const code = stripTrivia(source);
  return /\b[A-Za-z_][A-Za-z0-9_]*\s*:\s*\(\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:=\s*[-+]?\d+)?\s*,/i.test(code);
}

function sourceSpanText(content: string, object: TcGenObject): string {
  return content.split(/\r?\n/).slice(object.sourceSpan.startLine - 1, object.sourceSpan.endLine).join("\n");
}
