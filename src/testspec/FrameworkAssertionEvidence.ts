import { createHash } from "node:crypto";
import type { FrameworkAssertionEvidence } from "../domain/models.js";
import { sanitizeCompilerOutput } from "../domain/reportSanitizer.js";
import { stripTrivia } from "../normalizer/tokenRewrite.js";
import { analyzeTargetAssertionLinkage } from "./FrameworkTargetAssertionLink.js";

type AssertionCall = {
  name: string;
  start: number;
  end: number;
  argumentsText: string;
};

/**
 * Extract review evidence from the exact submitted Framework function block.
 * Source text is never rewritten: IDs bind the submitted file hash, source
 * location, ordinal and assertion method. Literal smoke checks and obvious
 * self-comparisons are omitted because they are not meaningful assertions.
 */
export function extractFrameworkAssertionEvidence(input: {
  source: string;
  sourcePath: string;
  sourceSha256: string;
  sourceStartLine: number;
  testFunctionBlock: string;
  productionTarget: string;
}): FrameworkAssertionEvidence[] {
  const calls = assertionCalls(input.source).filter(call => isMeaningfulAssertion(call));
  const evidence: FrameworkAssertionEvidence[] = [];
  let priorLinkedCount = 0;

  for (const [index, call] of calls.entries()) {
    const codeThroughCall = stripTrivia(input.source.slice(0, call.end));
    const linkedCount = analyzeTargetAssertionLinkage(
      codeThroughCall,
      input.productionTarget
    ).targetLinkedAssertionCount;
    const sourceLine = Math.max(
      1,
      input.sourceStartLine + newlineCount(input.source.slice(0, call.start))
    );
    const description = sanitizeAssertionDescription(assertionDescription(call.argumentsText));
    const assertionId = "assertion:" + sha256(
      [
        input.sourceSha256,
        input.testFunctionBlock,
        input.productionTarget,
        String(sourceLine),
        String(index + 1),
        call.name
      ].join("\0")
    );

    evidence.push({
      assertionId,
      testFunctionBlock: input.testFunctionBlock,
      productionTarget: input.productionTarget,
      assertionName: call.name,
      sourcePath: input.sourcePath,
      testSourceSha256: input.sourceSha256,
      sourceLine,
      ...(description ? { description } : {}),
      targetLinked: linkedCount > priorLinkedCount,
      status: "not_run",
      executionEvidence: "not_executed"
    });
    priorLinkedCount = linkedCount;
  }
  return evidence;
}

/** Associate source evidence with only what the wrapper backend proves. */
export function applyFrameworkAssertionExecution(
  assertions: readonly FrameworkAssertionEvidence[],
  tests: ReadonlyArray<{ name: string; status: "passed" | "failed" | "skipped"; message?: string }>,
  workspace?: string
): FrameworkAssertionEvidence[] {
  const byTest = new Map(tests.map(test => [test.name, test] as const));
  const assertionsByBlock = new Map<string, FrameworkAssertionEvidence[]>();
  for (const assertion of assertions) {
    const rows = assertionsByBlock.get(assertion.testFunctionBlock) ?? [];
    rows.push(assertion);
    assertionsByBlock.set(assertion.testFunctionBlock, rows);
  }

  const result: FrameworkAssertionEvidence[] = [];
  for (const [testFunctionBlock, rows] of assertionsByBlock) {
    const parent = byTest.get(`framework ${testFunctionBlock}`);
    if (parent?.status === "passed") {
      result.push(...rows.map(row => ({
        ...sanitizedAssertion(row, workspace),
        status: "passed" as const,
        executionEvidence: "parent_test_passed" as const
      })));
      continue;
    }
    if (parent?.status === "failed") {
      const parentMessage = sanitizeAssertionDescription(
        sanitizeCompilerOutput(parent.message ?? "", workspace)
      );
      const identified = uniquelyIdentifiedFailure(rows, parentMessage, workspace);
      result.push(...rows.map(row => ({
        ...sanitizedAssertion(row, workspace),
        status: row.assertionId === identified ? "failed" as const : "unknown" as const,
        executionEvidence: row.assertionId === identified
          ? "backend_message" as const
          : "parent_test_failed" as const
      })));
      continue;
    }
    result.push(...rows.map(row => sanitizedAssertion(row, workspace)));
  }
  return result;
}

function uniquelyIdentifiedFailure(
  assertions: readonly FrameworkAssertionEvidence[],
  backendMessage: string,
  workspace?: string
): string | undefined {
  if (!backendMessage) return undefined;
  const matches = assertions.filter(assertion => {
    const description = sanitizeAssertionDescription(assertion.description ?? "");
    return description.length >= 3 && backendMessage.includes(description);
  });
  return matches.length === 1 ? matches[0].assertionId : undefined;
}

function sanitizedAssertion(
  assertion: FrameworkAssertionEvidence,
  _workspace?: string
): FrameworkAssertionEvidence {
  if (!assertion.description) return { ...assertion };
  return {
    ...assertion,
    description: sanitizeAssertionDescription(assertion.description)
  };
}

function assertionCalls(source: string): AssertionCall[] {
  const masked = stripTrivia(source);
  const matcher = /\bm_xAssert[A-Za-z0-9_]*\s*\(/gi;
  const result: AssertionCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked)) !== null) {
    const open = masked.indexOf("(", match.index);
    const close = matchingParenthesis(masked, open);
    if (open < 0 || close < 0) continue;
    const name = /^\s*(m_xAssert[A-Za-z0-9_]*)/i.exec(match[0])?.[1] ?? "m_xAssert";
    result.push({
      name,
      start: match.index,
      end: close + 1,
      argumentsText: source.slice(open + 1, close)
    });
    matcher.lastIndex = close + 1;
  }
  return result;
}

function matchingParenthesis(code: string, open: number): number {
  if (open < 0 || code[open] !== "(") return -1;
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === "(") depth++;
    if (code[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function isMeaningfulAssertion(call: AssertionCall): boolean {
  const argumentsList = splitArguments(call.argumentsText);
  const observed = assertionObservedArguments(call.name, argumentsList);
  if (obviousSelfComparison(call.name, observed)) return false;
  const withoutStrings = stripTrivia(observed.join(","));
  for (const match of withoutStrings.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const identifier = match[0].toLowerCase();
    if (!nonObservedIdentifiers.has(identifier)) return true;
  }
  return false;
}

function assertionObservedArguments(name: string, values: string[]): string[] {
  const argumentsList = values
    .filter(value => !/^\s*i_s(?:message|description)\s*:=/i.test(value))
    .map(withoutNamedArgument);
  const lowered = name.toLowerCase();
  if (lowered === "m_xasserttrue" || lowered === "m_xassertfalse") {
    return argumentsList.slice(0, 1);
  }
  if (lowered === "m_xassertinrange") return argumentsList.slice(0, 3);
  return argumentsList.slice(0, 2);
}

function obviousSelfComparison(name: string, values: string[]): boolean {
  if (!name.toLowerCase().includes("equal") || values.length < 2) return false;
  return normalizedExpression(values[0]) === normalizedExpression(values[1]);
}

function normalizedExpression(value: string): string {
  return stripTrivia(value).replace(/\s+/g, "").toLowerCase();
}

function assertionDescription(argumentsText: string): string {
  const values = splitArguments(argumentsText);
  const named = values.find(value => /^\s*i_s(?:message|description)\s*:=/i.test(value));
  const candidate = named
    ? withoutNamedArgument(named)
    : [...values].reverse().find(value => /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*#\s*)?'/.test(value));
  if (!candidate) return "";
  const match = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*#\s*)?'([\s\S]*)'\s*$/.exec(candidate);
  return match ? match[1].replace(/''/g, "'") : "";
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const current = value[index];
    if (quote) {
      if (current === quote && value[index + 1] === quote) {
        index++;
      } else if (current === quote) {
        quote = "";
      }
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (current === "(" || current === "[") depth++;
    if (current === ")" || current === "]") depth = Math.max(0, depth - 1);
    if (current === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function withoutNamedArgument(value: string): string {
  return value.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:=\s*/, "");
}

function sanitizeAssertionDescription(value: string): string {
  const sanitized = value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<(?:workspace|temp)>/gi, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s'";,)]*/g, "<path>")
    .replace(/\\\\[^\s'";,)]*/g, "<path>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-jwt>")
    .replace(/\b(token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .trim();
  return [...sanitized].slice(0, 1_000).join("");
}

function newlineCount(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const nonObservedIdentifiers = new Set([
  "true", "false", "null",
  "not", "and", "and_then", "or", "or_else", "xor", "mod",
  "bool", "byte", "word", "dword", "lword",
  "sint", "int", "dint", "lint", "usint", "uint", "udint", "ulint",
  "real", "lreal", "string", "wstring",
  "time", "ltime", "date", "ldate", "tod", "ltod", "dt", "ldt"
]);
