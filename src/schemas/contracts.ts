export const tcgenTestSpecSchema = {
  $id: "https://tcgen.dev/schemas/tcgen-test-spec.schema.json",
  type: "object",
  required: ["schemaVersion", "name", "target", "tests"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    target: {
      type: "object",
      required: ["pouName", "kind"],
      additionalProperties: false,
      properties: {
        pouName: { type: "string", minLength: 1 },
        kind: { enum: ["FUNCTION_BLOCK", "FUNCTION", "PROGRAM"] },
        instanceName: { type: "string", minLength: 1 }
      }
    },
    setup: { type: "array", items: { $ref: "#/$defs/step" } },
    tests: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "steps"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          steps: { type: "array", items: { $ref: "#/$defs/step" } }
        }
      }
    }
  },
  $defs: {
    jsonValue: true,
    step: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "path", "value"],
          additionalProperties: false,
          properties: {
            kind: { const: "set" },
            path: { type: "string", minLength: 1 },
            value: { $ref: "#/$defs/jsonValue" }
          }
        },
        {
          type: "object",
          required: ["kind"],
          additionalProperties: false,
          properties: {
            kind: { const: "call" },
            target: { type: "string", minLength: 1 },
            arguments: { type: "object" },
            cycles: { type: "integer", minimum: 1 }
          }
        },
        {
          type: "object",
          required: ["kind", "nanoseconds"],
          additionalProperties: false,
          properties: {
            kind: { const: "advanceTime" },
            nanoseconds: { type: "integer", minimum: 0 }
          }
        },
        {
          type: "object",
          required: ["kind", "path", "value"],
          additionalProperties: false,
          properties: {
            kind: { enum: ["expectEquals", "expectNotEquals"] },
            path: { type: "string", minLength: 1 },
            value: { $ref: "#/$defs/jsonValue" },
            message: { type: "string" }
          }
        },
        {
          type: "object",
          required: ["kind", "path"],
          additionalProperties: false,
          properties: {
            kind: { enum: ["expectTrue", "expectFalse"] },
            path: { type: "string", minLength: 1 },
            message: { type: "string" }
          }
        },
        {
          type: "object",
          required: ["kind", "path", "value"],
          additionalProperties: false,
          properties: {
            kind: { enum: ["expectGreaterThan", "expectLessThan"] },
            path: { type: "string", minLength: 1 },
            value: { type: "number" },
            message: { type: "string" }
          }
        }
      ]
    }
  }
} as const;

const diagnosticSchema = {
  type: "object",
  required: ["severity", "blocking", "code", "message"],
  additionalProperties: true,
  properties: {
    severity: { enum: ["info", "warning", "error"] },
    blocking: { type: "boolean" },
    code: { type: "string", minLength: 1 },
    message: { type: "string" },
    original: { $ref: "#/$defs/sourceSpan" },
    generated: { $ref: "#/$defs/sourceSpan" },
    object: { type: "string" },
    ruleId: { type: "string" },
    suggestion: { type: "string" }
  }
} as const;

export const normalizationReportSchema = {
  $id: "https://tcgen.dev/schemas/normalization-report.schema.json",
  type: "object",
  required: ["schemaVersion", "parseStatus", "compatibilityStatus", "normalizedFiles", "normalization", "diagnostics", "hashes"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    parseStatus: { enum: ["ok", "error"] },
    compatibilityStatus: { enum: ["exact", "rewritten", "partial", "blocked"] },
    normalizedFiles: {
      type: "array",
      items: { $ref: "#/$defs/normalizedFile" }
    },
    normalization: { $ref: "#/$defs/normalizationSummary" },
    diagnostics: {
      type: "array",
      items: { $ref: "#/$defs/diagnostic" }
    },
    hashes: {
      type: "object",
      required: ["request"],
      additionalProperties: false,
      properties: {
        request: { type: "string" },
        normalizedSource: { type: "string" }
      }
    }
  },
  $defs: commonReportDefs()
} as const;

export const semanticReportSchema = {
  $id: "https://tcgen.dev/schemas/semantic-report.schema.json",
  type: "object",
  required: ["schemaVersion", "verdict", "backend", "normalization", "summary", "tests", "diagnostics", "hashes", "qualification"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    verdict: { enum: ["passed", "failed", "partial", "unsupported", "compile_error", "backend_error", "timeout"] },
    backend: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { const: "strucpp" },
        version: { type: "string" },
        executable: { type: "string" },
        cliMode: { enum: ["native", "node"] },
        gppExecutable: { type: "string" }
      }
    },
    normalization: { $ref: "#/$defs/normalizationSummary" },
    summary: {
      type: "object",
      required: ["passed", "failed", "skipped", "compileErrors", "runtimeErrors"],
      additionalProperties: false,
      properties: {
        passed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        skipped: { type: "integer", minimum: 0 },
        compileErrors: { type: "integer", minimum: 0 },
        runtimeErrors: { type: "integer", minimum: 0 }
      }
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "status"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: { enum: ["passed", "failed", "skipped"] },
          message: { type: "string" }
        }
      }
    },
    diagnostics: {
      type: "array",
      items: { $ref: "#/$defs/diagnostic" }
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        normalizedFiles: {
          type: "array",
          items: { $ref: "#/$defs/normalizedFile" }
        },
        testFile: { $ref: "#/$defs/normalizedFile" },
        generatedTestFile: { $ref: "#/$defs/normalizedFile" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        workspace: { type: "string" }
      }
    },
    hashes: {
      type: "object",
      required: ["request"],
      additionalProperties: false,
      properties: {
        request: { type: "string" },
        normalizedSource: { type: "string" },
        testSource: { type: "string" }
      }
    },
    qualification: { type: "string", minLength: 1 }
  },
  $defs: commonReportDefs()
} as const;

function commonReportDefs() {
  return {
    sourceSpan: {
      type: "object",
      required: ["path", "startLine", "endLine"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        startColumn: { type: "integer", minimum: 1 },
        endColumn: { type: "integer", minimum: 1 }
      }
    },
    diagnostic: diagnosticSchema,
    rewriteRecord: {
      type: "object",
      required: ["ruleId", "originalText", "generatedText", "sourceSpan", "generatedSpan"],
      additionalProperties: false,
      properties: {
        ruleId: { type: "string" },
        originalText: { type: "string" },
        generatedText: { type: "string" },
        sourceSpan: { $ref: "#/$defs/sourceSpan" },
        generatedSpan: { $ref: "#/$defs/sourceSpan" }
      }
    },
    normalizedFile: {
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      }
    },
    normalizationSummary: {
      type: "object",
      required: ["profile", "status", "includedObjects", "omittedObjects", "blockedObjects", "symbolMap", "rewrites", "diagnostics"],
      additionalProperties: false,
      properties: {
        profile: { const: "tcgen-strucpp-v1" },
        status: { enum: ["exact", "rewritten", "partial", "blocked"] },
        includedObjects: { type: "array", items: { type: "string" } },
        omittedObjects: { type: "array", items: { type: "string" } },
        blockedObjects: { type: "array", items: { type: "string" } },
        symbolMap: {
          type: "object",
          additionalProperties: { type: "string" }
        },
        rewrites: {
          type: "array",
          items: { $ref: "#/$defs/rewriteRecord" }
        },
        diagnostics: {
          type: "array",
          items: { $ref: "#/$defs/diagnostic" }
        }
      }
    }
  } as const;
}
