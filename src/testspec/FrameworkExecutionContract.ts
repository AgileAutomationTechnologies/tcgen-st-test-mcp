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

    diagnostics.push(...validateExecuteMethod(test, execute));
    if (busyObserver) diagnostics.push(...validateBusyObserver(test, busyObserver));
  }
  return diagnostics;
}

function validateBusyObserver(test: TcGenObject, busyObserver: TcGenObject): Diagnostic[] {
  const code = stripTrivia(busyObserver.implementationText);
  const stateAssignments = [...code.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*:=/gi)]
    .map(match => match[1])
    .filter(target => target.toLowerCase() !== "m_xisbusy");
  if (stateAssignments.length === 0) return [];
  return [
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
  ];
}

function validateExecuteMethod(test: TcGenObject, execute: TcGenObject): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const code = stripTrivia(`${execute.declarationText}\n${execute.implementationText}`);
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
    return diagnostics;
  }

  const startsBusyPhase = /\b_xPhaseBusy\s*:=\s*TRUE\b/i.test(triggerFlow.trueBranch);
  if (!startsBusyPhase || triggerBranchCompletesSynchronously(triggerFlow.trueBranch)) {
    return diagnostics;
  }

  const reachableResumeSource = reachableFalseTriggerSource(triggerFlow);
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
  return diagnostics;
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
    .map(branch => branch.body);
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
