/**
 * Conservative source-level linkage between Framework assertions and their
 * mapped production target. A target invocation plus an unrelated local
 * assertion must never be accepted as production coverage.
 */

export interface TargetAssertionLinkage {
  targetInstances: string[];
  targetLinkedAssertionCount: number;
}

type ParsedCall = {
  name: string;
  start: number;
  end: number;
  arguments: string;
};

type LinkEvent =
  | { position: number; order: 0; kind: "assignment"; lhs: string; rhs: string }
  | { position: number; order: 1; kind: "targetCall"; call: ParsedCall }
  | { position: number; order: 2; kind: "assertion"; call: ParsedCall };

export function analyzeTargetAssertionLinkage(
  code: string,
  productionTarget: string
): TargetAssertionLinkage {
  if (!code || !productionTarget.trim()) {
    return { targetInstances: [], targetLinkedAssertionCount: 0 };
  }

  const targetInstances = findTargetInstances(code, productionTarget);
  const roots = new Set(targetInstances.map(value => value.toLowerCase()));
  const directTarget = productionTarget.toLowerCase();
  const linkedVariables = new Set<string>();
  const parsedCalls = calls(code);
  const events: LinkEvent[] = [
    ...assignments(code).map(value => ({ ...value, order: 0 as const, kind: "assignment" as const })),
    ...parsedCalls
      .filter(call => roots.has(call.name.toLowerCase()) || call.name.toLowerCase() === directTarget)
      .map(call => ({ position: call.start, order: 1 as const, kind: "targetCall" as const, call })),
    ...parsedCalls
      .filter(call => call.name.toLowerCase().startsWith("m_xassert"))
      .map(call => ({ position: call.start, order: 2 as const, kind: "assertion" as const, call }))
  ].sort((left, right) => left.position - right.position || left.order - right.order);

  let targetLinkedAssertionCount = 0;
  for (const event of events) {
    if (event.kind === "assignment") {
      const key = event.lhs.toLowerCase();
      if (expressionIsTargetLinked(event.rhs, roots, directTarget, linkedVariables)) {
        linkedVariables.add(key);
      } else {
        linkedVariables.delete(key);
      }
      continue;
    }
    if (event.kind === "targetCall") {
      for (const match of event.call.arguments.matchAll(/=>\s*([A-Za-z_][A-Za-z0-9_]*)\b/gi)) {
        linkedVariables.add(match[1].toLowerCase());
      }
      continue;
    }
    if (isObviousSelfComparison(event.call)) continue;
    if (observedAssertionOperands(event.call).some(
      operand => expressionIsTargetLinked(operand, roots, directTarget, linkedVariables)
    )) {
      targetLinkedAssertionCount++;
    }
  }

  return { targetInstances, targetLinkedAssertionCount };
}

function findTargetInstances(code: string, productionTarget: string): string[] {
  const declaration = new RegExp(
    `\\b([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*`
      + `(?:[A-Za-z_][A-Za-z0-9_]*\\.)*${escapeRegExp(productionTarget)}\\b[^;]*;`,
    "gi"
  );
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of code.matchAll(declaration)) {
    const name = match[1];
    if (!seen.has(name.toLowerCase())) {
      result.push(name);
      seen.add(name.toLowerCase());
    }
  }
  return result;
}

function calls(code: string): ParsedCall[] {
  const result: ParsedCall[] = [];
  const matcher = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(code)) !== null) {
    const open = code.indexOf("(", match.index);
    const close = matchingParenthesis(code, open);
    if (open < 0 || close < 0) continue;
    result.push({
      name: match[1],
      start: match.index,
      end: close + 1,
      arguments: code.slice(open + 1, close)
    });
  }
  return result;
}

function assignments(code: string): Array<{ position: number; lhs: string; rhs: string }> {
  const result: Array<{ position: number; lhs: string; rhs: string }> = [];
  let statementStart = 0;
  for (let statementEnd = 0; statementEnd < code.length; statementEnd++) {
    if (code[statementEnd] !== ";") continue;
    const statement = code.slice(statementStart, statementEnd);
    const assignmentIndex = topLevelAssignmentIndex(statement);
    if (assignmentIndex >= 0) {
      const prefix = statement.slice(0, assignmentIndex);
      const declaration = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*$/.exec(prefix);
      const plain = /(?:^|[^.A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(prefix);
      const lhs = declaration?.[1] ?? plain?.[1];
      if (lhs) {
        result.push({
          position: statementStart + assignmentIndex,
          lhs,
          rhs: statement.slice(assignmentIndex + 2)
        });
      }
    }
    statementStart = statementEnd + 1;
  }
  return result;
}

function topLevelAssignmentIndex(statement: string): number {
  let depth = 0;
  for (let index = 0; index + 1 < statement.length; index++) {
    if (statement[index] === "(" || statement[index] === "[") depth++;
    if (statement[index] === ")" || statement[index] === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && statement.slice(index, index + 2) === ":=") return index;
  }
  return -1;
}

function observedAssertionOperands(call: ParsedCall): string[] {
  const args = splitArguments(call.arguments).map(withoutNamedArgument);
  const name = call.name.toLowerCase();
  if (name === "m_xasserttrue" || name === "m_xassertfalse" || name === "m_xassertinrange") {
    return args.length > 0 ? [args[0]] : [];
  }
  if (name.startsWith("m_xassertequal")) return args.length > 1 ? [args[1]] : [];
  return [];
}

function isObviousSelfComparison(call: ParsedCall): boolean {
  const args = splitArguments(call.arguments).map(withoutNamedArgument);
  const name = call.name.toLowerCase();
  if (name.startsWith("m_xassertequal") && args.length >= 2) {
    return normalizedExpression(args[0]) === normalizedExpression(args[1]);
  }
  if ((name !== "m_xasserttrue" && name !== "m_xassertfalse") || args.length === 0) return false;
  const comparison = /^\s*(.+?)\s*(=|<>)\s*(.+?)\s*$/.exec(args[0]);
  return comparison !== null
    && normalizedExpression(comparison[1]) === normalizedExpression(comparison[3]);
}

function normalizedExpression(value: string): string {
  let result = value.replace(/\s+/g, "").toLowerCase();
  while (result.startsWith("(") && result.endsWith(")") && matchingParenthesis(result, 0) === result.length - 1) {
    result = result.slice(1, -1);
  }
  return result;
}

function withoutNamedArgument(value: string): string {
  return value.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:=\s*/, "");
}

function expressionIsTargetLinked(
  expression: string,
  roots: Set<string>,
  directTarget: string,
  linkedVariables: Set<string>
): boolean {
  const identifiers = new Set(
    [...expression.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map(match => match[0].toLowerCase())
  );
  if ([...identifiers].some(identifier => roots.has(identifier) || linkedVariables.has(identifier))) {
    return true;
  }
  return new RegExp(`\\b${escapeRegExp(directTarget)}\\s*\\(`, "i").test(expression);
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(" || value[index] === "[") depth++;
    if (value[index] === ")" || value[index] === "]") depth = Math.max(0, depth - 1);
    if (value[index] === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function matchingParenthesis(text: string, openIndex: number): number {
  if (openIndex < 0) return -1;
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    if (text[index] === "(") depth++;
    if (text[index] === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
