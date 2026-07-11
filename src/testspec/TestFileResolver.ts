import {
  Diagnostic,
  FrameworkTestConfig,
  NormalizeRequest,
  NormalizedFile,
  TcGenTestSpec,
  diagnostic
} from "../domain/models.js";
import { NormalizeResult, NormalizeRuntimeOptions } from "../normalizer/TcGenToStrucppNormalizer.js";
import { FrameworkTestBuilder, omitFrameworkInfrastructure, replaceFrameworkRunnerProgram } from "./FrameworkTestBuilder.js";
import { GeneratedTestFile, StrucppTestGenerator } from "./StrucppTestGenerator.js";

export type TestRequest = NormalizeRequest & {
  testSpec?: TcGenTestSpec;
  frameworkTest?: FrameworkTestConfig;
};

export interface ResolvedTestFile extends GeneratedTestFile {
  sourceFiles: NormalizedFile[];
  mode?: "testSpec" | "framework";
  discoveredFrameworkTests?: string[];
  selectedFrameworkTests?: string[];
}

export function normalizerOptionsForTestRequest(request: TestRequest): NormalizeRuntimeOptions {
  return hasFrameworkTest(request)
    ? { omitObject: omitFrameworkInfrastructure, replaceObject: replaceFrameworkRunnerProgram }
    : {};
}

export function resolveTestFile(request: TestRequest, normalized: NormalizeResult): ResolvedTestFile {
  const spec = hasTestSpec(request);
  const framework = hasFrameworkTest(request);

  if (spec && framework) {
    return errorTestFile("TCTEST_INPUT_CONFLICT", "Use either testSpec or frameworkTest, not both.");
  }
  if (!spec && !framework) {
    return errorTestFile("TCTEST_INPUT_REQUIRED", "testSpec or frameworkTest is required.");
  }
  if (spec) {
    return { ...new StrucppTestGenerator().generate(request.testSpec as TcGenTestSpec), sourceFiles: [], mode: "testSpec" };
  }

  return new FrameworkTestBuilder().generate(normalized, request.frameworkTest);
}

function hasTestSpec(request: TestRequest): boolean {
  return request.testSpec !== undefined && request.testSpec !== null;
}

function hasFrameworkTest(request: TestRequest): boolean {
  return request.frameworkTest !== undefined && request.frameworkTest !== null;
}

function errorTestFile(code: string, message: string): ResolvedTestFile {
  const diagnostics: Diagnostic[] = [diagnostic("error", code, message)];
  return {
    path: "semantic_tests.st",
    content: "",
    diagnostics,
    hash: "",
    sourceFiles: []
  };
}
