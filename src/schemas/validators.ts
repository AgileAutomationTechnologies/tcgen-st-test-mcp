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
  return validateWith("TCTEST_SCHEMA_VALIDATION", validators.tcgenTestSpec, value);
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
