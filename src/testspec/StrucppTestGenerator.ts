import { createHash } from "node:crypto";
import { Diagnostic, TcGenTestSpec, TestStep, diagnostic } from "../domain/models.js";
import { validateTcGenTestSpec } from "../schemas/validators.js";

export interface GeneratedTestFile {
  path: string;
  content: string;
  diagnostics: Diagnostic[];
  hash: string;
  generatedTestNames: string[];
  coveredExecutableObjects: string[];
}

export class StrucppTestGenerator {
  generate(spec: TcGenTestSpec): GeneratedTestFile {
    const diagnostics = [...validateTcGenTestSpec(spec), ...validateSpec(spec)];
    if (diagnostics.some(item => item.blocking)) {
      return {
        path: "semantic_tests.st",
        content: "",
        diagnostics,
        hash: "",
        generatedTestNames: [],
        coveredExecutableObjects: []
      };
    }

    const target = spec.target;
    const instanceName = sanitizeIdentifier(target.instanceName || "dut");
    const lines: string[] = [];
    for (const test of spec.tests) {
      lines.push(`TEST '${escapeString(test.name)}'`);
      if (target.kind !== "FUNCTION") {
        lines.push("VAR");
        lines.push(`    ${instanceName} : ${target.pouName};`);
        lines.push("END_VAR");
      }
      for (const step of spec.setup ?? []) {
        lines.push(...emitStep(step, target, instanceName));
      }
      for (const step of test.steps) {
        lines.push(...emitStep(step, target, instanceName));
      }
      lines.push("END_TEST", "");
    }

    const content = lines.join("\n").trimEnd() + "\n";
    return {
      path: "semantic_tests.st",
      content,
      diagnostics,
      hash: createHash("sha256").update(content).digest("hex"),
      generatedTestNames: spec.tests.map(test => test.name),
      coveredExecutableObjects: [spec.target.pouName]
    };
  }
}

function validateSpec(spec: TcGenTestSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(spec) || spec.schemaVersion !== 1) {
    diagnostics.push(diagnostic("error", "TCTEST_SCHEMA_VERSION", "Test spec schemaVersion must be 1."));
    return diagnostics;
  }
  if (!spec.name?.trim()) diagnostics.push(diagnostic("error", "TCTEST_NAME_REQUIRED", "Test spec name is required."));
  if (!spec.target?.pouName?.trim()) diagnostics.push(diagnostic("error", "TCTEST_TARGET_REQUIRED", "Test target pouName is required."));
  if (!["FUNCTION_BLOCK", "FUNCTION", "PROGRAM"].includes(spec.target?.kind ?? "")) {
    diagnostics.push(diagnostic("error", "TCTEST_TARGET_KIND", "Target kind must be FUNCTION_BLOCK, FUNCTION, or PROGRAM."));
  }
  if (!Array.isArray(spec.tests) || spec.tests.length === 0) diagnostics.push(diagnostic("error", "TCTEST_TESTS_REQUIRED", "At least one test is required."));
  for (const step of spec.setup ?? []) {
    validateStep(step, "setup", diagnostics);
  }
  for (const test of spec.tests ?? []) {
    if (!test.name?.trim()) diagnostics.push(diagnostic("error", "TCTEST_CASE_NAME_REQUIRED", "Every test requires a name."));
    if (!Array.isArray(test.steps)) diagnostics.push(diagnostic("error", "TCTEST_STEPS_REQUIRED", `Test '${test.name}' requires steps.`));
    for (const step of test.steps ?? []) {
      validateStep(step, `test '${test.name}'`, diagnostics);
    }
  }
  return diagnostics;
}

function validateStep(step: TestStep, location: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(step) || typeof step.kind !== "string") {
    diagnostics.push(diagnostic("error", "TCTEST_STEP_KIND", `Every ${location} step requires a kind.`));
    return;
  }
  switch (step.kind) {
    case "set":
      requirePath(step.path, location, diagnostics);
      break;
    case "call":
      if (step.cycles !== undefined && (!Number.isInteger(step.cycles) || step.cycles < 1)) {
        diagnostics.push(diagnostic("error", "TCTEST_CALL_CYCLES", `Call step in ${location} requires cycles >= 1 when provided.`));
      }
      break;
    case "advanceTime":
      if (!Number.isInteger(step.nanoseconds) || step.nanoseconds < 0) {
        diagnostics.push(diagnostic("error", "TCTEST_ADVANCE_TIME", `advanceTime step in ${location} requires a non-negative integer nanoseconds value.`));
      }
      break;
    case "expectEquals":
    case "expectNotEquals":
    case "expectTrue":
    case "expectFalse":
      requirePath(step.path, location, diagnostics);
      break;
    case "expectGreaterThan":
    case "expectLessThan":
      requirePath(step.path, location, diagnostics);
      if (typeof step.value !== "number" || !Number.isFinite(step.value)) {
        diagnostics.push(diagnostic("error", "TCTEST_NUMERIC_EXPECTATION", `${step.kind} in ${location} requires a finite numeric value.`));
      }
      break;
    default:
      diagnostics.push(diagnostic("error", "TCTEST_STEP_KIND", `Unsupported test step kind '${String((step as { kind?: unknown }).kind)}' in ${location}.`));
      break;
  }
}

function requirePath(path: unknown, location: string, diagnostics: Diagnostic[]): void {
  if (typeof path !== "string" || !path.trim()) {
    diagnostics.push(diagnostic("error", "TCTEST_PATH_REQUIRED", `Step in ${location} requires a non-empty path.`));
  }
}

function emitStep(step: TestStep, target: TcGenTestSpec["target"], instanceName: string): string[] {
  switch (step.kind) {
    case "set":
      return [`${emitPath(step.path, instanceName)} := ${literal(step.value)};`];
    case "call":
      return emitCall(step, target, instanceName);
    case "advanceTime":
      return [`ADVANCE_TIME(${step.nanoseconds});`];
    case "expectEquals":
      return [assertCall("ASSERT_EQ", [emitPath(step.path, instanceName), literal(step.value)], step.message)];
    case "expectNotEquals":
      return [assertCall("ASSERT_NEQ", [emitPath(step.path, instanceName), literal(step.value)], step.message)];
    case "expectTrue":
      return [assertCall("ASSERT_TRUE", [emitPath(step.path, instanceName)], step.message)];
    case "expectFalse":
      return [assertCall("ASSERT_FALSE", [emitPath(step.path, instanceName)], step.message)];
    case "expectGreaterThan":
      return [assertCall("ASSERT_GT", [emitPath(step.path, instanceName), literal(step.value)], step.message)];
    case "expectLessThan":
      return [assertCall("ASSERT_LT", [emitPath(step.path, instanceName), literal(step.value)], step.message)];
  }
}

function emitCall(step: Extract<TestStep, { kind: "call" }>, target: TcGenTestSpec["target"], instanceName: string): string[] {
  const cycles = Math.max(1, Math.floor(step.cycles ?? 1));
  const callTarget = step.target || (target.kind === "FUNCTION" ? target.pouName : instanceName);
  const args = step.arguments ?? {};
  const renderedArgs = Object.entries(args).map(([key, value]) => `${key} := ${literal(value)}`).join(", ");
  const call = `${callTarget}(${renderedArgs});`;
  return Array.from({ length: cycles }, () => call);
}

function emitPath(path: string, instanceName: string): string {
  const trimmed = path.trim();
  if (!trimmed) return instanceName;
  if (trimmed === "$target") return instanceName;
  if (trimmed.startsWith("$target.")) return `${instanceName}.${trimmed.slice("$target.".length)}`;
  return trimmed;
}

function literal(value: unknown): string {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string") return `'${escapeString(value)}'`;
  if (value === null) return "0";
  return `'${escapeString(JSON.stringify(value))}'`;
}

function assertCall(name: string, args: string[], message: string | undefined): string {
  const rendered = message ? [...args, literal(message)].join(", ") : args.join(", ");
  return `${name}(${rendered});`;
}

function escapeString(value: string): string {
  return value.replace(/'/g, "''").replace(/\r?\n/g, "\\n");
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
