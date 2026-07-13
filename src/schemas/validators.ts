import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { Diagnostic, diagnostic } from "../domain/models.js";
import { normalizationReportSchema, semanticReportSchema, tcgenTestSpecSchema } from "./contracts.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });

const validators = {
  tcgenTestSpec: ajv.compile(tcgenTestSpecSchema),
  semanticReport: ajv.compile(semanticReportSchema),
  normalizationReport: ajv.compile(normalizationReportSchema)
};

export function validateTcGenTestSpec(value: unknown): Diagnostic[] {
  return [
    ...validateWith("TCTEST_SCHEMA_VALIDATION", validators.tcgenTestSpec, value),
    ...validateUniqueTestNames(value)
  ];
}

function validateUniqueTestNames(value: unknown): Diagnostic[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { tests?: unknown }).tests)) return [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, string>();
  for (const item of (value as { tests: unknown[] }).tests) {
    if (!item || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string") continue;
    const name = (item as { name: string }).name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const original = seen.get(key);
    if (original !== undefined) {
      diagnostics.push(
        diagnostic(
          "error",
          "TCTEST_DUPLICATE_NAME",
          `Test name '${name}' duplicates '${original}'. Test names must be unique ignoring case and surrounding whitespace.`
        )
      );
    } else {
      seen.set(key, name);
    }
  }
  return diagnostics;
}

export function validateSemanticReport(value: unknown): Diagnostic[] {
  return validateWith("TCREPORT_SCHEMA_VALIDATION", validators.semanticReport, value);
}

export function validateNormalizationReport(value: unknown): Diagnostic[] {
  return validateWith("TCREPORT_SCHEMA_VALIDATION", validators.normalizationReport, value);
}

function validateWith(code: string, validator: ValidateFunction, value: unknown): Diagnostic[] {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error =>
    diagnostic("error", codeFor(error, code), `${schemaPath(error)} ${error.message ?? "is invalid"}.`, {
      suggestion: "Check the published JSON schema for the expected contract."
    })
  );
}

function codeFor(error: ErrorObject, fallback: string): string {
  if (error.instancePath.endsWith("/nanoseconds")) return "TCTEST_ADVANCE_TIME";
  if (error.instancePath.endsWith("/cycles")) return "TCTEST_CALL_CYCLES";
  if (error.instancePath.endsWith("/path")) return "TCTEST_PATH_REQUIRED";
  if (error.instancePath.endsWith("/target/kind")) return "TCTEST_TARGET_KIND";
  if (error.instancePath.endsWith("/tests")) return "TCTEST_TESTS_REQUIRED";
  if (error.instancePath.endsWith("/name")) return "TCTEST_NAME_REQUIRED";
  if (error.instancePath.endsWith("/target/pouName")) return "TCTEST_TARGET_REQUIRED";
  return fallback;
}

function schemaPath(error: ErrorObject): string {
  return error.instancePath || "/";
}
