import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { spawn } from "node:child_process";
import {
  BackendCheckResult,
  Diagnostic,
  diagnostic,
} from "../domain/models.js";
import { sanitizeCompilerOutput } from "../domain/reportSanitizer.js";
import {
  copyStandardFunctionBlockContracts,
  loadStandardFunctionBlockContracts,
  standardFunctionBlockContractCandidates,
  standardFunctionBlockContractGeneration,
  unavailableStandardFunctionBlockContracts,
} from "./StandardFunctionBlockContracts.js";

export interface BackendRunResult {
  status: "passed" | "failed" | "compile_error" | "backend_error" | "timeout";
  executionAttempted: boolean;
  executable?: string;
  command?: string;
  argumentsPrefix?: string[];
  cliMode?: "native" | "node";
  version?: string;
  gppExecutable?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  diagnostics: Diagnostic[];
  tests: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    message?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  standardFunctionBlockContracts: ReturnType<
    typeof copyStandardFunctionBlockContracts
  >;
  standardFunctionBlockContractQualified: boolean;
}

type ResolvedCommand = {
  executable: string;
  command: string;
  argsPrefix: string[];
  mode: "native" | "node";
  cwd?: string;
};

type ResolvedGpp = {
  available: boolean;
  executable?: string;
  diagnostics: Diagnostic[];
};

type ResolvedBackend = {
  command: ResolvedCommand;
  version: string;
  standardFunctionBlockContracts: ReturnType<
    typeof copyStandardFunctionBlockContracts
  >;
};

export const testedStrucppVersion = "0.5.13-tcgen.4";
const developmentMsys2Gpp = "C:\\msys64\\ucrt64\\bin\\g++.exe";
const bundledStrucppRelativePath = join("backend", "strucpp-win.exe");
const bundledGppRelativePath = join("toolchain", "mingw64", "bin", "g++.exe");
const verifiedRuntimeManifests = new Set<string>();
const runtimeManifestChecks = new Map<string, Promise<string | undefined>>();
const cpp17CompilerChecks = new Map<
  string,
  { generation: string; result: Promise<Cpp17CompilerCheck> }
>();
const semanticRuntimeChecks = new Map<
  string,
  { generation: string; result: Promise<SemanticRuntimeCheck> }
>();
const semanticRejectedStrucppOverrides = new Map<string, string>();

type SemanticRuntimeCheck = {
  available: boolean;
  detail?: string;
};

type Cpp17CompilerCheck = {
  available: boolean;
  code?:
    "CPP17_COMPILE_FAILED" | "CPP17_EXECUTION_FAILED" | "CPP17_SELF_TEST_ERROR";
  detail?: string;
};

function standardFunctionBlockQualification(
  contracts: ReturnType<typeof copyStandardFunctionBlockContracts> | undefined,
  qualified: boolean,
): Pick<
  BackendCheckResult,
  "standardFunctionBlockContracts" | "standardFunctionBlockContractQualified"
> {
  return {
    standardFunctionBlockContracts: copyStandardFunctionBlockContracts(
      contracts ?? unavailableStandardFunctionBlockContracts(),
    ),
    standardFunctionBlockContractQualified: qualified,
  };
}

export class StrucppBackend {
  async check(): Promise<BackendCheckResult> {
    const diagnostics: Diagnostic[] = [];
    const gpp = await resolveCompatibleGpp(true);
    diagnostics.push(...gpp.diagnostics);
    const runtimeIntegrity = await verifyRuntimeManifest(diagnostics);
    const backend =
      runtimeIntegrity && gpp.available && gpp.executable
        ? await resolveRuntimeCompatibleStrucpp(gpp.executable, diagnostics)
        : await resolveCompatibleStrucpp(diagnostics);
    if (!backend) {
      return {
        backend: "strucpp",
        available: false,
        testedVersion: testedStrucppVersion,
        ...standardFunctionBlockQualification(undefined, false),
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [
                diagnostic(
                  "error",
                  "STRUCPP_NOT_FOUND",
                  "STruC++ executable was not found via STRUCPP_PATH or PATH.",
                ),
              ],
      };
    }

    return {
      backend: "strucpp",
      available: runtimeIntegrity && gpp.available,
      executable: backend.command.executable,
      command: backend.command.command,
      argumentsPrefix: backend.command.argsPrefix,
      cliMode: backend.command.mode,
      version: backend.version,
      testedVersion: testedStrucppVersion,
      gppAvailable: gpp.available,
      gppExecutable: gpp.executable,
      ...standardFunctionBlockQualification(
        backend.standardFunctionBlockContracts,
        runtimeIntegrity && gpp.available,
      ),
      diagnostics,
    };
  }

  async run(
    sourcePaths: string[],
    testPath: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onTestResult?: (test: BackendRunResult["tests"][number]) => void;
      virtualFixturePath?: string;
      libraryProfile?: string;
    } = {},
  ): Promise<BackendRunResult> {
    const diagnostics: Diagnostic[] = [];
    const gpp = await resolveCompatibleGpp(true);
    diagnostics.push(...gpp.diagnostics);
    const runtimeIntegrity = await verifyRuntimeManifest(diagnostics);
    const backend =
      runtimeIntegrity && gpp.available && gpp.executable
        ? await resolveRuntimeCompatibleStrucpp(gpp.executable, diagnostics)
        : await resolveCompatibleStrucpp(diagnostics);
    if (!backend) {
      return {
        status: "backend_error",
        executionAttempted: false,
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [
                diagnostic(
                  "error",
                  "STRUCPP_NOT_FOUND",
                  "STruC++ executable was not found via STRUCPP_PATH or PATH.",
                ),
              ],
        tests: [],
        ...standardFunctionBlockQualification(undefined, false),
      };
    }

    if (!runtimeIntegrity) {
      return {
        status: "backend_error",
        executionAttempted: false,
        executable: backend.command.executable,
        command: backend.command.command,
        argumentsPrefix: backend.command.argsPrefix,
        cliMode: backend.command.mode,
        version: backend.version,
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        diagnostics,
        tests: [],
        ...standardFunctionBlockQualification(
          backend.standardFunctionBlockContracts,
          false,
        ),
      };
    }
    if (!gpp.available || !gpp.executable) {
      return {
        status: "backend_error",
        executionAttempted: false,
        executable: backend.command.executable,
        command: backend.command.command,
        argumentsPrefix: backend.command.argsPrefix,
        cliMode: backend.command.mode,
        version: backend.version,
        gppExecutable: gpp.executable,
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        diagnostics,
        tests: [],
        ...standardFunctionBlockQualification(
          backend.standardFunctionBlockContracts,
          false,
        ),
      };
    }

    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? 30_000, 1_000),
      120_000,
    );
    const args = [
      ...sourcePaths,
      ...(options.libraryProfile
        ? ["--library-profile", options.libraryProfile]
        : []),
      ...(options.virtualFixturePath
        ? ["--virtual-fixture", options.virtualFixturePath]
        : []),
      "--gpp",
      gpp.executable,
      "--test",
      testPath,
    ];
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const observedTests = new Map<string, BackendRunResult["tests"][number]>();
    const pendingLiveFailureDetails: string[] = [];
    const result = await spawnWithTimeout(
      backend.command,
      args,
      timeoutMs,
      gpp.executable,
      dirname(testPath),
      options.signal,
      (line) => {
        const trimmed = line.trim();
        if (
          /^ASSERT_[A-Z_]+\s+failed:/i.test(trimmed) ||
          (pendingLiveFailureDetails.length > 0 &&
            /^at\s+.+:\d+/i.test(trimmed))
        ) {
          pendingLiveFailureDetails.push(trimmed);
          return;
        }
        const parsed = parseTestResultLine(line);
        if (!parsed || observedTests.has(parsed.name)) return;
        const test = {
          ...parsed,
          ...(parsed.status === "failed" && pendingLiveFailureDetails.length > 0
            ? { message: pendingLiveFailureDetails.join("\n") }
            : {}),
          startedAt,
          completedAt: new Date().toISOString(),
        };
        pendingLiveFailureDetails.length = 0;
        observedTests.set(test.name, test);
        options.onTestResult?.(test);
      },
    );
    if (result.cancelled) {
      diagnostics.push(
        diagnostic(
          "error",
          "SANDBOX_CANCELLED",
          "STruC++ execution was cancelled and its process tree was terminated.",
        ),
      );
      return {
        status: "backend_error",
        executionAttempted: true,
        executable: backend.command.executable,
        command: backend.command.command,
        argumentsPrefix: backend.command.argsPrefix,
        cliMode: backend.command.mode,
        version: backend.version,
        gppExecutable: gpp.executable,
        durationMs: Date.now() - started,
        diagnostics,
        tests: [],
        ...standardFunctionBlockQualification(
          backend.standardFunctionBlockContracts,
          true,
        ),
        ...result,
      };
    }
    if (result.timedOut) {
      diagnostics.push(
        diagnostic(
          "error",
          "SANDBOX_TIMEOUT",
          `STruC++ timed out after ${timeoutMs} ms.`,
        ),
      );
      return {
        status: "timeout",
        executionAttempted: true,
        executable: backend.command.executable,
        command: backend.command.command,
        argumentsPrefix: backend.command.argsPrefix,
        cliMode: backend.command.mode,
        version: backend.version,
        gppExecutable: gpp.executable,
        durationMs: Date.now() - started,
        diagnostics,
        tests: [],
        ...standardFunctionBlockQualification(
          backend.standardFunctionBlockContracts,
          true,
        ),
        ...result,
      };
    }

    const completedAt = new Date().toISOString();
    const tests = parseTests(result.stdout + "\n" + result.stderr).map(
      (test) => ({
        ...test,
        startedAt,
        completedAt: observedTests.get(test.name)?.completedAt ?? completedAt,
      }),
    );
    const status = classifyBackendRun(
      result.exitCode,
      result.stdout,
      result.stderr,
      tests,
    );
    if (result.exitCode === 0 && executedTestCount(tests) === 0) {
      diagnostics.push(
        diagnostic(
          "error",
          "STRUCPP_NO_TEST_RESULTS",
          "STruC++ exited successfully but reported no executed semantic tests; the result is not trusted.",
        ),
      );
    }
    return {
      status,
      executionAttempted: true,
      executable: backend.command.executable,
      command: backend.command.command,
      argumentsPrefix: backend.command.argsPrefix,
      cliMode: backend.command.mode,
      version: backend.version,
      gppExecutable: gpp.executable,
      durationMs: Date.now() - started,
      diagnostics,
      tests,
      ...standardFunctionBlockQualification(
        backend.standardFunctionBlockContracts,
        true,
      ),
      ...result,
    };
  }
}

function validateTestedVersion(
  version: string | undefined,
  diagnostics: Diagnostic[],
): version is string {
  if (!version) {
    diagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_VERSION_UNVERIFIED",
        `STruC++ ${testedStrucppVersion} is required, but the backend version could not be verified.`,
      ),
    );
    return false;
  }
  const detected = detectStrucppVersion(version);
  if (detected === testedStrucppVersion) return true;
  diagnostics.push(
    diagnostic(
      "error",
      "STRUCPP_VERSION_MISMATCH",
      `STruC++ version '${version}' is not accepted; this semantic runner is pinned to ${testedStrucppVersion}.`,
    ),
  );
  return false;
}

export function detectStrucppVersion(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return /^(?:STruC\+\+ version )?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)$/.exec(
    value.trim(),
  )?.[1];
}

async function resolveCompatibleStrucpp(
  diagnostics: Diagnostic[],
): Promise<ResolvedBackend | undefined> {
  const explicitPath = process.env.STRUCPP_PATH?.trim();
  if (explicitPath) {
    const overrideDiagnostics: Diagnostic[] = [];
    const override = await resolveStrucppPath(
      explicitPath,
      overrideDiagnostics,
    );
    if (override) {
      const version = await runVersion(override, overrideDiagnostics);
      const detected = detectStrucppVersion(version);
      if (detected === testedStrucppVersion) {
        const contract = await resolveStandardFunctionBlockContracts(
          override,
          overrideDiagnostics,
        );
        const overrideIdentity = resolve(override.executable).toLowerCase();
        const overrideGeneration = await semanticRuntimeGeneration(override);
        if (
          contract &&
          semanticRejectedStrucppOverrides.get(overrideIdentity) !==
            overrideGeneration
        ) {
          semanticRejectedStrucppOverrides.delete(overrideIdentity);
          diagnostics.push(...overrideDiagnostics);
          return {
            command: override,
            version: detected,
            standardFunctionBlockContracts: contract,
          };
        }
        diagnostics.push(
          ...overrideDiagnostics.map((item) => ({
            ...item,
            severity: "warning" as const,
            blocking: false,
          })),
          diagnostic(
            "warning",
            "STRUCPP_OVERRIDE_RUNTIME_INCOMPATIBLE",
            contract
              ? "The configured STruC++ override previously failed the semantic runtime self-test; using the bundled runtime."
              : "The configured STruC++ override has no qualified compiler-generated IEC function-block contract; using the bundled runtime.",
            { blocking: false },
          ),
        );
      } else {
        diagnostics.push(
          diagnostic(
            "warning",
            "STRUCPP_OVERRIDE_VERSION_MISMATCH",
            `Configured STruC++ '${explicitPath}' reports '${version ?? "unknown"}', not ${testedStrucppVersion}; falling back to the bundled runtime.`,
            { blocking: false },
          ),
        );
      }
    } else {
      diagnostics.push(
        ...overrideDiagnostics.map((item) => ({
          ...item,
          severity: "warning" as const,
          blocking: false,
        })),
      );
    }
  }

  const bundled = await resolveBundledStrucpp(diagnostics);
  if (bundled) return bundled;

  if (!explicitPath) {
    diagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_NOT_FOUND",
        `Bundled STruC++ ${testedStrucppVersion} is missing. Run TcGen installer Repair.`,
      ),
    );
  } else {
    diagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_BUNDLED_FALLBACK_MISSING",
        "The configured STruC++ override is incompatible and the bundled runtime is missing. Run TcGen installer Repair.",
      ),
    );
  }
  return undefined;
}

async function resolveRuntimeCompatibleStrucpp(
  gppExecutable: string,
  diagnostics: Diagnostic[],
): Promise<ResolvedBackend | undefined> {
  const selected = await resolveCompatibleStrucpp(diagnostics);
  if (!selected) return undefined;

  const selectedDiagnostics: Diagnostic[] = [];
  if (
    await verifySemanticRuntime(
      selected.command,
      gppExecutable,
      selectedDiagnostics,
    )
  ) {
    diagnostics.push(...selectedDiagnostics);
    return selected;
  }

  const bundledPath = resolvePackFile(bundledStrucppRelativePath);
  const selectedIsOverride = Boolean(
    process.env.STRUCPP_PATH?.trim() &&
    bundledPath &&
    !samePath(selected.command.executable, bundledPath),
  );
  if (!selectedIsOverride) {
    diagnostics.push(...selectedDiagnostics);
    return undefined;
  }

  semanticRejectedStrucppOverrides.set(
    resolve(selected.command.executable).toLowerCase(),
    await semanticRuntimeGeneration(selected.command),
  );
  diagnostics.push(
    ...selectedDiagnostics.map((item) => ({
      ...item,
      severity: "warning" as const,
      blocking: false,
    })),
    diagnostic(
      "warning",
      "STRUCPP_OVERRIDE_RUNTIME_INCOMPATIBLE",
      "The configured STruC++ override failed the semantic runtime self-test; using the bundled runtime.",
      { blocking: false },
    ),
  );
  const bundledDiagnostics: Diagnostic[] = [];
  const bundled = await resolveBundledStrucpp(bundledDiagnostics);
  if (!bundled) {
    diagnostics.push(...bundledDiagnostics);
    return undefined;
  }
  if (
    !(await verifySemanticRuntime(
      bundled.command,
      gppExecutable,
      bundledDiagnostics,
    ))
  ) {
    diagnostics.push(...bundledDiagnostics);
    return undefined;
  }
  diagnostics.push(...bundledDiagnostics);
  return bundled;
}

async function resolveBundledStrucpp(
  diagnostics: Diagnostic[],
): Promise<ResolvedBackend | undefined> {
  const bundledPath = resolvePackFile(bundledStrucppRelativePath);
  if (!bundledPath || !(await fileExists(bundledPath))) return undefined;
  const command = nativeCommand(bundledPath, dirname(bundledPath));
  const version = await runVersion(command, diagnostics);
  if (!validateTestedVersion(version, diagnostics)) return undefined;
  const contract = await resolveStandardFunctionBlockContracts(
    command,
    diagnostics,
  );
  if (!contract) return undefined;
  return {
    command,
    version: testedStrucppVersion,
    standardFunctionBlockContracts: contract,
  };
}

async function resolveStandardFunctionBlockContracts(
  command: ResolvedCommand,
  diagnostics: Diagnostic[],
): Promise<ReturnType<typeof copyStandardFunctionBlockContracts> | undefined> {
  const candidates = standardFunctionBlockContractCandidates({
    executable: command.executable,
    cwd: command.cwd,
    packRoot: packRoot(),
  });
  try {
    const loaded = await loadStandardFunctionBlockContracts(candidates);
    return loaded.contracts;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_STANDARD_FB_CONTRACT_INVALID",
        `The pinned STruC++ compiler-generated IEC function-block contract could not be qualified: ${error instanceof Error ? error.message : String(error)}. Run TcGen installer Repair.`,
        { sourceKind: "backend" },
      ),
    );
    return undefined;
  }
}

async function resolveStrucppPath(
  explicitPath: string,
  diagnostics: Diagnostic[],
): Promise<ResolvedCommand | undefined> {
  if (explicitPath?.trim()) {
    const resolved = resolve(explicitPath.trim());
    const resolvedStat = await tryStat(resolved);
    if (resolvedStat?.isDirectory()) {
      const bundledWin = join(resolved, "dist", "bin", "strucpp-win.exe");
      if (await fileExists(bundledWin))
        return nativeCommand(bundledWin, resolved);
      const repoCli = join(resolved, "dist", "node", "cli.js");
      if (await fileExists(repoCli))
        return resolveNodeCommand(repoCli, resolved, diagnostics);
      diagnostics.push(
        diagnostic(
          "error",
          "STRUCPP_PATH_INVALID",
          `STRUCPP_PATH directory '${resolved}' does not contain dist/node/cli.js or a bundled strucpp executable.`,
        ),
      );
      return undefined;
    }

    if (resolvedStat?.isFile()) {
      return isJavaScriptCli(resolved)
        ? resolveNodeCommand(
            resolved,
            inferRepoRootFromCli(resolved),
            diagnostics,
          )
        : nativeCommand(resolved, dirname(resolved));
    }

    diagnostics.push(
      diagnostic(
        "error",
        "STRUCPP_PATH_INVALID",
        `STRUCPP_PATH '${resolved}' does not exist.`,
      ),
    );
    return undefined;
  }

  return undefined;
}

async function resolveGpp(forRun: boolean): Promise<ResolvedGpp> {
  const explicit = process.env.STRUCPP_GPP_PATH?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    if (await fileExists(resolved))
      return { available: true, executable: resolved, diagnostics: [] };
    const bundled = resolvePackFile(bundledGppRelativePath);
    if (bundled && (await fileExists(bundled))) {
      return {
        available: true,
        executable: bundled,
        diagnostics: [
          diagnostic(
            "warning",
            "STRUCPP_GPP_PATH_INVALID",
            `Configured compiler '${resolved}' does not exist; using the bundled compiler.`,
            { blocking: false },
          ),
        ],
      };
    }
    return {
      available: false,
      executable: resolved,
      diagnostics: [
        diagnostic(
          forRun ? "error" : "warning",
          "STRUCPP_GPP_PATH_INVALID",
          `Configured compiler '${resolved}' does not exist and the bundled compiler is missing. Run TcGen installer Repair.`,
          { blocking: forRun },
        ),
      ],
    };
  }

  const bundled = resolvePackFile(bundledGppRelativePath);
  if (bundled && (await fileExists(bundled)))
    return { available: true, executable: bundled, diagnostics: [] };

  // Source-checkout development remains convenient; packaged runtimes never consult global PATH.
  if (!packRoot()) {
    const developmentGpp = await locateExecutable("g++");
    if (developmentGpp)
      return { available: true, executable: developmentGpp, diagnostics: [] };
    if (await fileExists(developmentMsys2Gpp))
      return {
        available: true,
        executable: developmentMsys2Gpp,
        diagnostics: [],
      };
  }

  return {
    available: false,
    diagnostics: [
      diagnostic(
        forRun ? "error" : "warning",
        "STRUCPP_GPP_NOT_FOUND",
        "The bundled C++ compiler is missing. Run TcGen installer Repair, or configure an advanced compiler override.",
        {
          blocking: forRun,
        },
      ),
    ],
  };
}

async function resolveCompatibleGpp(forRun: boolean): Promise<ResolvedGpp> {
  const selected = await resolveGpp(forRun);
  if (!selected.available || !selected.executable) return selected;

  const validationDiagnostics: Diagnostic[] = [];
  if (await verifyCpp17Compiler(selected.executable, validationDiagnostics))
    return selected;

  const explicit = process.env.STRUCPP_GPP_PATH?.trim();
  const bundled = resolvePackFile(bundledGppRelativePath);
  if (
    explicit &&
    bundled &&
    (await fileExists(bundled)) &&
    !samePath(selected.executable, bundled)
  ) {
    const bundledDiagnostics: Diagnostic[] = [];
    if (await verifyCpp17Compiler(bundled, bundledDiagnostics)) {
      return {
        available: true,
        executable: bundled,
        diagnostics: [
          ...selected.diagnostics,
          ...validationDiagnostics.map((item) => ({
            ...item,
            severity: "warning" as const,
            blocking: false,
          })),
          diagnostic(
            "warning",
            "STRUCPP_GPP_OVERRIDE_INCOMPATIBLE",
            `Configured compiler '${selected.executable}' failed the C++17 self-test; using the bundled compiler.`,
            { blocking: false },
          ),
        ],
      };
    }
    validationDiagnostics.push(...bundledDiagnostics);
  }

  return {
    available: false,
    executable: selected.executable,
    diagnostics: [...selected.diagnostics, ...validationDiagnostics],
  };
}

function packRoot(): string | undefined {
  const configured = process.env.TCGEN_ST_TEST_PACK_DIR?.trim();
  if (configured) return resolve(configured);
  return undefined;
}

function resolvePackFile(relativePath: string): string | undefined {
  const root = packRoot();
  return root ? join(root, relativePath) : undefined;
}

export async function verifyRuntimeManifest(
  diagnostics: Diagnostic[],
): Promise<boolean> {
  const root = packRoot();
  if (!root) return true;
  const manifestPath = join(root, "runtime-manifest.json");
  try {
    const manifestText = (await readFile(manifestPath, "utf8")).replace(
      /^\uFEFF/,
      "",
    );
    const manifestIdentity = `${root.toLowerCase()}|${createHash("sha256").update(manifestText, "utf8").digest("hex")}`;
    const manifest = JSON.parse(manifestText) as {
      files?: Array<{ path?: string; sha256?: string; size?: number }>;
    };
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error("manifest does not contain a non-empty files array");
    }

    const requiredPaths = new Set([
      "runtime/tcgen-st-test-mcp.exe",
      "backend/strucpp-win.exe",
      "backend/libs/iec-standard-fb.stlib",
      "backend/libs/iec-function-block-contracts.json",
      "backend/libs/profiles/beckhoff-virtual.json",
      "backend/libs/beckhoff-virtual/beckhoff-virtual-core.stlib",
      "backend/libs/sources/beckhoff-virtual-core/beckhoff-api-catalog.json",
      "backend/runtime/include/beckhoff_virtual.hpp",
      "toolchain/mingw64/bin/g++.exe",
    ]);
    const seen = new Set<string>();
    const entries = manifest.files.map((entry) => {
      const normalized = normalizedManifestPath(entry.path);
      if (!normalized)
        throw new Error(
          `manifest contains an unsafe file path '${String(entry.path ?? "")}'`,
        );
      const identity = normalized.toLowerCase();
      if (seen.has(identity))
        throw new Error(
          `manifest contains duplicate file path '${normalized}'`,
        );
      seen.add(identity);
      requiredPaths.delete(identity);
      if (!/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) {
        throw new Error(
          `manifest contains an invalid SHA-256 for '${normalized}'`,
        );
      }
      if (
        entry.size !== undefined &&
        (!Number.isSafeInteger(entry.size) || entry.size < 0)
      ) {
        throw new Error(
          `manifest contains an invalid size for '${normalized}'`,
        );
      }
      return { ...entry, normalized };
    });
    const profilePath = join(
      root,
      "backend",
      "libs",
      "profiles",
      "beckhoff-virtual.json",
    );
    const profile = JSON.parse(
      (await readFile(profilePath, "utf8")).replace(/^\uFEFF/, ""),
    ) as {
      schemaVersion?: number;
      name?: string;
      runtimeProfile?: string;
      libraries?: Array<{ name?: string; path?: string }>;
    };
    if (
      profile.schemaVersion !== 1 ||
      profile.name !== "beckhoff-virtual" ||
      profile.runtimeProfile !== "beckhoff-virtual-v1" ||
      !Array.isArray(profile.libraries) ||
      profile.libraries.length === 0
    ) {
      throw new Error("beckhoff-virtual profile identity is invalid");
    }
    for (const [index, library] of profile.libraries.entries()) {
      if (
        typeof library.name !== "string" ||
        typeof library.path !== "string"
      ) {
        throw new Error(`beckhoff-virtual profile library ${index} is invalid`);
      }
      const packagedPath = normalizedManifestPath(
        `backend/libs/${library.path}`,
      );
      if (!packagedPath || !seen.has(packagedPath.toLowerCase())) {
        throw new Error(
          `manifest is missing profile archive ${packagedPath ?? library.path}`,
        );
      }
    }
    const coverageCatalog = JSON.parse(
      (
        await readFile(
          join(
            root,
            "backend",
            "libs",
            "sources",
            "beckhoff-virtual-core",
            "beckhoff-api-catalog.json",
          ),
          "utf8",
        )
      ).replace(/^\uFEFF/, ""),
    ) as {
      schemaVersion?: number;
      coverage?: { indexedPages?: number; libraryIdentities?: number };
    };
    if (
      coverageCatalog.schemaVersion !== 1 ||
      coverageCatalog.coverage?.indexedPages !== 688 ||
      coverageCatalog.coverage.libraryIdentities !== 34
    ) {
      throw new Error("Beckhoff coverage catalog identity is invalid");
    }
    if (requiredPaths.size > 0) {
      throw new Error(`manifest is missing ${[...requiredPaths].join(", ")}`);
    }

    const concurrency = 8;
    const runtimeFiles: Array<{
      normalized: string;
      sha256: string;
      fullPath: string;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }> = [];
    for (let offset = 0; offset < entries.length; offset += concurrency) {
      const inspected = await Promise.all(
        entries.slice(offset, offset + concurrency).map(async (entry) => {
          const fullPath = join(root, ...entry.normalized.split("/"));
          try {
            const fileStat = await stat(fullPath);
            if (!fileStat.isFile())
              return {
                failure: `runtime entry '${entry.normalized}' is not a file`,
              };
            if (entry.size !== undefined && fileStat.size !== entry.size) {
              return {
                failure: `runtime entry '${entry.normalized}' has an unexpected size`,
              };
            }
            return {
              file: {
                normalized: entry.normalized,
                sha256: entry.sha256!,
                fullPath,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
                ctimeMs: fileStat.ctimeMs,
              },
            };
          } catch {
            return {
              failure: `runtime entry '${entry.normalized}' is missing or unreadable`,
            };
          }
        }),
      );
      const failure = inspected.find((item) => item.failure)?.failure;
      if (failure) {
        clearRuntimeManifestCache(root);
        diagnostics.push(
          diagnostic(
            "error",
            "RUNTIME_INTEGRITY_FAILED",
            `Virtual Tests ${failure}. Run TcGen installer Repair.`,
          ),
        );
        return false;
      }
      runtimeFiles.push(
        ...inspected.flatMap((item) => (item.file ? [item.file] : [])),
      );
    }

    const runtimeGeneration = createHash("sha256")
      .update(
        JSON.stringify(
          runtimeFiles.map((file) => [
            file.normalized,
            file.size,
            file.mtimeMs,
            file.ctimeMs,
          ]),
        ),
        "utf8",
      )
      .digest("hex");
    const runtimeIdentity = `${manifestIdentity}|${runtimeGeneration}`;
    if (verifiedRuntimeManifests.has(runtimeIdentity)) return true;

    let integrityCheck = runtimeManifestChecks.get(runtimeIdentity);
    if (!integrityCheck) {
      integrityCheck = verifyRuntimeFileHashes(runtimeFiles, concurrency);
      runtimeManifestChecks.set(runtimeIdentity, integrityCheck);
    }
    const hashFailure = await integrityCheck;
    if (hashFailure) {
      clearRuntimeManifestCache(root);
      diagnostics.push(
        diagnostic(
          "error",
          "RUNTIME_INTEGRITY_FAILED",
          `Virtual Tests ${hashFailure}. Run TcGen installer Repair.`,
        ),
      );
      return false;
    }
    rememberVerifiedRuntimeIdentity(root, runtimeIdentity);
    return true;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "error",
        "RUNTIME_MANIFEST_INVALID",
        `Virtual Tests runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}. Run TcGen installer Repair.`,
      ),
    );
    return false;
  }
}

function clearRuntimeManifestCache(root: string): void {
  const prefix = `${root.toLowerCase()}|`;
  for (const identity of verifiedRuntimeManifests) {
    if (identity.startsWith(prefix)) verifiedRuntimeManifests.delete(identity);
  }
  for (const identity of runtimeManifestChecks.keys()) {
    if (identity.startsWith(prefix)) runtimeManifestChecks.delete(identity);
  }
}

function rememberVerifiedRuntimeIdentity(
  root: string,
  runtimeIdentity: string,
): void {
  const prefix = `${root.toLowerCase()}|`;
  for (const identity of verifiedRuntimeManifests) {
    if (identity.startsWith(prefix) && identity !== runtimeIdentity) {
      verifiedRuntimeManifests.delete(identity);
    }
  }
  for (const identity of runtimeManifestChecks.keys()) {
    if (identity.startsWith(prefix) && identity !== runtimeIdentity) {
      runtimeManifestChecks.delete(identity);
    }
  }
  verifiedRuntimeManifests.add(runtimeIdentity);
}

async function verifyRuntimeFileHashes(
  runtimeFiles: ReadonlyArray<{
    normalized: string;
    sha256: string;
    fullPath: string;
  }>,
  concurrency: number,
): Promise<string | undefined> {
  for (let offset = 0; offset < runtimeFiles.length; offset += concurrency) {
    const failures = await Promise.all(
      runtimeFiles.slice(offset, offset + concurrency).map(async (file) => {
        try {
          const actual = await sha256File(file.fullPath);
          return actual.toLowerCase() === file.sha256.toLowerCase()
            ? ""
            : `runtime entry '${file.normalized}' failed SHA-256 verification`;
        } catch {
          return `runtime entry '${file.normalized}' is missing or unreadable`;
        }
      }),
    );
    const failure = failures.find(Boolean);
    if (failure) return failure;
  }
  return undefined;
}

function normalizedManifestPath(value: string | undefined): string | undefined {
  const raw = (value ?? "").trim().replace(/\\/g, "/");
  if (!raw || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return undefined;
  const segments = raw.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    return undefined;
  return segments.join("/");
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function verifySemanticRuntime(
  command: ResolvedCommand,
  gppExecutable: string,
  diagnostics: Diagnostic[],
): Promise<boolean> {
  const identity = [
    resolve(command.executable).toLowerCase(),
    command.argsPrefix.join("|"),
    resolve(gppExecutable).toLowerCase(),
    (packRoot() ?? "development").toLowerCase(),
  ].join("|");
  const generation = await semanticRuntimeGeneration(command);

  let cached = semanticRuntimeChecks.get(identity);
  if (!cached || cached.generation !== generation) {
    cached = {
      generation,
      result: runSemanticRuntimeSelfTest(command, gppExecutable),
    };
    semanticRuntimeChecks.set(identity, cached);
  }
  const result = await cached.result;
  if (result.available) return true;

  diagnostics.push(
    diagnostic(
      "error",
      "STRUCPP_SEMANTIC_SELF_TEST_FAILED",
      `STruC++ could not compile and execute its pinned IEC/Beckhoff virtual-profile, TwinCAT RS/SR named-pin, and short-circuit self-test${result.detail ? `: ${result.detail}` : ""}. Run TcGen installer Repair.`,
      { sourceKind: "backend" },
    ),
  );
  return false;
}

async function semanticRuntimeGeneration(
  command: ResolvedCommand,
): Promise<string> {
  const paths = new Set<string>([
    resolve(command.executable),
    ...command.argsPrefix
      .filter((value) => !value.startsWith("-"))
      .map((value) => resolve(value)),
  ]);
  if (command.cwd) {
    paths.add(join(command.cwd, "libs", "iec-standard-fb.stlib"));
    paths.add(join(command.cwd, "libs", "iec-function-block-contracts.json"));
    paths.add(
      join(command.cwd, "libs", "sources", "iec-standard-fb", "library.json"),
    );
    paths.add(
      join(command.cwd, "libs", "sources", "iec-standard-fb", "bistable.st"),
    );
    paths.add(
      join(command.cwd, "libs", "sources", "iec-standard-fb", "timer.st"),
    );
    paths.add(join(command.cwd, "libs", "profiles", "beckhoff-virtual.json"));
    paths.add(
      join(
        command.cwd,
        "libs",
        "beckhoff-virtual",
        "beckhoff-virtual-core.stlib",
      ),
    );
    paths.add(
      join(
        command.cwd,
        "libs",
        "sources",
        "beckhoff-virtual-core",
        "beckhoff-api-catalog.json",
      ),
    );
    paths.add(
      join(command.cwd, "src", "runtime", "include", "beckhoff_virtual.hpp"),
    );
    try {
      const profilePath = join(
        command.cwd,
        "libs",
        "profiles",
        "beckhoff-virtual.json",
      );
      const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
        libraries?: Array<{ path?: string }>;
      };
      for (const library of profile.libraries ?? []) {
        if (typeof library.path === "string") {
          paths.add(join(command.cwd, "libs", library.path));
        }
      }
    } catch {
      // The missing/invalid profile path already participates in generation.
    }
  }

  const contractGeneration = await standardFunctionBlockContractGeneration(
    standardFunctionBlockContractCandidates({
      executable: command.executable,
      cwd: command.cwd,
      packRoot: packRoot(),
    }),
  );

  const generation = [];
  for (const path of [...paths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const fileStat = await tryStat(path);
    generation.push([
      path.toLowerCase(),
      fileStat?.isFile() ?? false,
      fileStat?.size ?? -1,
      fileStat?.mtimeMs ?? -1,
      fileStat?.ctimeMs ?? -1,
    ]);
  }
  return createHash("sha256")
    .update(JSON.stringify([generation, contractGeneration]), "utf8")
    .digest("hex");
}

async function runSemanticRuntimeSelfTest(
  command: ResolvedCommand,
  gppExecutable: string,
): Promise<SemanticRuntimeCheck> {
  const directory = await mkdtemp(join(tmpdir(), "tcgen-strucpp-check-"));
  const sourcePath = join(directory, "runtime_self_test.st");
  const testPath = join(directory, "semantic_tests.st");
  const fixturePath = join(directory, "beckhoff-virtual-fixture.json");
  try {
    await writeFile(
      fixturePath,
      JSON.stringify({
        schemaVersion: 1,
        profile: "beckhoff-virtual-v1",
        resources: [
          { kind: "motionAxis", key: "tcgen-self-test-axis", ads: 4242 },
        ],
        faults: [],
      }),
      "utf8",
    );
    await writeFile(
      sourcePath,
      [
        "FUNCTION_BLOCK FB_TcGenRuntimeSelfTest",
        "VAR_INPUT",
        "    xEnable : BOOL;",
        "END_VAR",
        "VAR_OUTPUT",
        "    xDone : BOOL;",
        "    nShortCircuitCalls : INT;",
        "    xSkippedAnd : BOOL;",
        "    xEvaluatedAnd : BOOL;",
        "    xSkippedOr : BOOL;",
        "    xEvaluatedOr : BOOL;",
        "    xRsIec : BOOL;",
        "    xRsTwinCat : BOOL;",
        "    xSrIec : BOOL;",
        "    xSrTwinCat : BOOL;",
        "    xRsResetDominant : BOOL;",
        "    xSrSetDominant : BOOL;",
        "    xBeckhoffProfile : BOOL;",
        "END_VAR",
        "VAR",
        "    tonDelay : TON;",
        "    rsIec : RS;",
        "    rsTwinCat : RS;",
        "    srIec : SR;",
        "    srTwinCat : SR;",
        "    rsResetDominant : RS;",
        "    srSetDominant : SR;",
        "    axis : AXIS_REF;",
        "    mcPower : MC_Power;",
        "END_VAR",
        "METHOD PRIVATE TcGenTouch : BOOL",
        "nShortCircuitCalls := nShortCircuitCalls + 1;",
        "TcGenTouch := TRUE;",
        "END_METHOD",
        "tonDelay(IN := xEnable, PT := T#1ms);",
        "rsIec(S := TRUE, R1 := FALSE);",
        "rsTwinCat(SET := TRUE, RESET1 := FALSE);",
        "srIec(S1 := TRUE, R := FALSE);",
        "srTwinCat(SET1 := TRUE, RESET := FALSE);",
        "rsResetDominant(SET := TRUE, RESET1 := TRUE);",
        "srSetDominant(SET1 := TRUE, RESET := TRUE);",
        "axis.ADS := 4242;",
        "mcPower(Axis := axis, Enable := TRUE);",
        "xRsIec := rsIec.Q1;",
        "xRsTwinCat := rsTwinCat.Q1;",
        "xSrIec := srIec.Q1;",
        "xSrTwinCat := srTwinCat.Q1;",
        "xRsResetDominant := rsResetDominant.Q1;",
        "xSrSetDominant := srSetDominant.Q1;",
        "xBeckhoffProfile := TRUE;",
        "xDone := tonDelay.Q;",
        "xSkippedAnd := FALSE AND_THEN TcGenTouch();",
        "xEvaluatedAnd := TRUE AND_THEN TcGenTouch();",
        "xSkippedOr := TRUE OR_ELSE TcGenTouch();",
        "xEvaluatedOr := FALSE OR_ELSE TcGenTouch();",
        "END_FUNCTION_BLOCK",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      testPath,
      [
        "TEST 'tcgen-runtime-self-test'",
        "VAR",
        "    dut : FB_TcGenRuntimeSelfTest;",
        "END_VAR",
        "dut(xEnable := TRUE);",
        "ASSERT_FALSE(dut.xDone);",
        "ASSERT_TRUE(dut.xRsIec);",
        "ASSERT_TRUE(dut.xRsTwinCat);",
        "ASSERT_TRUE(dut.xSrIec);",
        "ASSERT_TRUE(dut.xSrTwinCat);",
        "ASSERT_FALSE(dut.xRsResetDominant);",
        "ASSERT_TRUE(dut.xSrSetDominant);",
        "ASSERT_TRUE(dut.xBeckhoffProfile);",
        "ASSERT_FALSE(dut.xSkippedAnd);",
        "ASSERT_TRUE(dut.xEvaluatedAnd);",
        "ASSERT_TRUE(dut.xSkippedOr);",
        "ASSERT_TRUE(dut.xEvaluatedOr);",
        "ASSERT_EQ(dut.nShortCircuitCalls, 2);",
        "ADVANCE_TIME(1000000);",
        "dut(xEnable := TRUE);",
        "ASSERT_TRUE(dut.xDone);",
        "ASSERT_EQ(dut.nShortCircuitCalls, 4);",
        "END_TEST",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await spawnWithTimeout(
      command,
      [
        sourcePath,
        "--library-profile",
        "beckhoff-virtual",
        "--virtual-fixture",
        fixturePath,
        "--gpp",
        gppExecutable,
        "--test",
        testPath,
      ],
      30_000,
      gppExecutable,
      directory,
    );
    if (result.timedOut)
      return { available: false, detail: "the self-test timed out" };
    const tests = parseTests(`${result.stdout}\n${result.stderr}`);
    if (
      result.exitCode === 0 &&
      tests.length === 1 &&
      tests[0].name === "tcgen-runtime-self-test" &&
      tests[0].status === "passed"
    ) {
      return { available: true };
    }
    const detail = sanitizeCompilerOutput(
      (result.stderr || result.stdout || "no compiler diagnostic").trim(),
      directory,
    ).slice(0, 2_000);
    return { available: false, detail };
  } catch (error) {
    return {
      available: false,
      detail: sanitizeCompilerOutput(
        error instanceof Error ? error.message : String(error),
        directory,
      ).slice(0, 2_000),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyCpp17Compiler(
  executable: string,
  diagnostics: Diagnostic[],
): Promise<boolean> {
  const identity = resolve(executable).toLowerCase();
  const executableStat = await tryStat(executable);
  const generation = JSON.stringify([
    executableStat?.size ?? -1,
    executableStat?.mtimeMs ?? -1,
    executableStat?.ctimeMs ?? -1,
    (packRoot() ?? "development").toLowerCase(),
  ]);
  let cached = cpp17CompilerChecks.get(identity);
  if (!cached || cached.generation !== generation) {
    cached = {
      generation,
      result: runCpp17CompilerSelfTest(executable),
    };
    cpp17CompilerChecks.set(identity, cached);
  }
  const result = await cached.result;
  if (result.available) return true;
  diagnostics.push(
    diagnostic(
      "error",
      result.code ?? "CPP17_SELF_TEST_ERROR",
      result.detail ??
        "The configured C++ compiler failed its C++17 self-test. Run TcGen installer Repair.",
    ),
  );
  return false;
}

async function runCpp17CompilerSelfTest(
  executable: string,
): Promise<Cpp17CompilerCheck> {
  const directory = await mkdtemp(join(tmpdir(), "tcgen-cpp17-check-"));
  const source = join(directory, "self-test.cpp");
  const output = join(
    directory,
    process.platform === "win32" ? "self-test.exe" : "self-test",
  );
  try {
    await writeFile(
      source,
      '#include <iostream>\nint main(){ if constexpr (true) { std::cout << "tcgen-cpp17-ok"; } }\n',
      "utf8",
    );
    const compiler = nativeCommand(executable, directory);
    const compile = await spawnWithTimeout(
      compiler,
      ["-std=c++17", source, "-o", output],
      15_000,
      executable,
    );
    if (compile.exitCode !== 0) {
      const compilerDetail =
        sanitizeCompilerOutput(compile.stderr.trim(), directory) ||
        "unknown compiler error";
      return {
        available: false,
        code: "CPP17_COMPILE_FAILED",
        detail: `The configured C++ compiler failed the C++17 self-test: ${compilerDetail}. Run TcGen installer Repair.`,
      };
    }
    const run = await spawnWithTimeout(
      nativeCommand(output, directory),
      [],
      5_000,
      executable,
    );
    if (run.exitCode !== 0 || !run.stdout.includes("tcgen-cpp17-ok")) {
      return {
        available: false,
        code: "CPP17_EXECUTION_FAILED",
        detail:
          "The compiled C++17 self-test did not run successfully. Run TcGen installer Repair.",
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      code: "CPP17_SELF_TEST_ERROR",
      detail: `The configured C++ compiler could not run its C++17 self-test: ${sanitizeCompilerOutput(error instanceof Error ? error.message : String(error), directory)}. Run TcGen installer Repair.`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function resolveNodeCommand(
  cliPath: string,
  cwd: string | undefined,
  diagnostics: Diagnostic[],
): Promise<ResolvedCommand | undefined> {
  let nodeExecutable = process.execPath;
  if (isPackagedRuntime()) {
    const explicit = process.env.TCGEN_ST_NODE_PATH?.trim();
    if (explicit) {
      const resolved = resolve(explicit);
      if (
        !(await fileExists(resolved)) ||
        samePath(resolved, process.execPath)
      ) {
        diagnostics.push(
          diagnostic(
            "error",
            "TCGEN_ST_NODE_PATH_INVALID",
            `TCGEN_ST_NODE_PATH '${resolved}' does not identify an external Node.js executable.`,
          ),
        );
        return undefined;
      }
      nodeExecutable = resolved;
    } else {
      const pathNode = await locateExecutable("node");
      if (!pathNode || samePath(pathNode, process.execPath)) {
        diagnostics.push(
          diagnostic(
            "error",
            "STRUCPP_NODE_RUNTIME_NOT_FOUND",
            "The standalone MCP executable cannot launch a JavaScript STruC++ CLI through itself. Configure TCGEN_ST_NODE_PATH, add an external Node.js executable to PATH, or point STRUCPP_PATH at native strucpp-win.exe.",
          ),
        );
        return undefined;
      }
      nodeExecutable = pathNode;
    }
  }
  return {
    executable: cliPath,
    command: nodeExecutable,
    argsPrefix: [cliPath],
    mode: "node",
    cwd,
  };
}

function isPackagedRuntime(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function nativeCommand(executable: string, cwd?: string): ResolvedCommand {
  return {
    executable,
    command: executable,
    argsPrefix: [],
    mode: "native",
    cwd,
  };
}

function isJavaScriptCli(path: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
}

function inferRepoRootFromCli(cliPath: string): string {
  const normalized = cliPath.replace(/\\/g, "/");
  if (normalized.endsWith("/dist/node/cli.js"))
    return resolve(cliPath, "..", "..", "..");
  return dirname(cliPath);
}

async function locateExecutable(name: string): Promise<string | undefined> {
  const paths = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  const candidates =
    process.platform === "win32"
      ? [`${name}.exe`, `${name}.cmd`, name]
      : [name];
  for (const path of paths) {
    for (const candidate of candidates) {
      const full = join(path, candidate);
      if (await fileExists(full)) return full;
    }
  }
  return undefined;
}

async function runVersion(
  command: ResolvedCommand,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  const result = await spawnWithTimeout(command, ["--version"], 5_000);
  if (result.exitCode !== 0) {
    diagnostics.push(
      diagnostic(
        "warning",
        "STRUCPP_VERSION_FAILED",
        "Could not read STruC++ version.",
        { blocking: false },
      ),
    );
    return undefined;
  }
  return (result.stdout || result.stderr).trim();
}

function spawnWithTimeout(
  command: ResolvedCommand,
  args: string[],
  timeoutMs: number,
  gppExecutable?: string,
  semanticTempRoot?: string,
  signal?: AbortSignal,
  onOutputLine?: (line: string) => void,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
}> {
  return new Promise((resolveResult) => {
    let settled = false;
    let terminationReason: "timeout" | "cancelled" | undefined;
    const child = spawn(command.command, [...command.argsPrefix, ...args], {
      shell: false,
      windowsHide: true,
      cwd: command.cwd,
      env: backendChildEnvironment(gppExecutable, semanticTempRoot),
    });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let timer: NodeJS.Timeout | undefined;
    let childClosedResolve: (() => void) | undefined;
    const childClosed = new Promise<void>((resolve) => {
      childClosedResolve = resolve;
    });
    const onAbort = () => {
      void terminate("cancelled");
    };
    const finish = (result: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut?: boolean;
      cancelled?: boolean;
    }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const terminate = async (reason: "timeout" | "cancelled") => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      if (timer) clearTimeout(timer);
      await killProcessTreeAndWait(child.pid);
      await Promise.race([childClosed, delay(2_000)]);
      finish({
        stdout,
        stderr,
        exitCode: null,
        ...(reason === "timeout" ? { timedOut: true } : { cancelled: true }),
      });
    };
    timer = setTimeout(() => {
      void terminate("timeout");
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer = emitCompleteLines(
        stdoutLineBuffer + text,
        onOutputLine,
      );
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrLineBuffer = emitCompleteLines(
        stderrLineBuffer + text,
        onOutputLine,
      );
    });
    child.on("error", (error) => {
      childClosedResolve?.();
      if (terminationReason) return;
      finish({ stdout, stderr: stderr + error.message, exitCode: null });
    });
    child.on("close", (code) => {
      childClosedResolve?.();
      if (terminationReason) return;
      if (stdoutLineBuffer)
        emitCompleteLines(`${stdoutLineBuffer}\n`, onOutputLine);
      if (stderrLineBuffer)
        emitCompleteLines(`${stderrLineBuffer}\n`, onOutputLine);
      finish({ stdout, stderr, exitCode: code });
    });
  });
}

function emitCompleteLines(
  value: string,
  observer: ((line: string) => void) | undefined,
): string {
  const lines = value.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    try {
      observer?.(line);
    } catch {
      // Streaming progress is advisory and must never affect the semantic run.
    }
  }
  return remainder;
}

async function killProcessTreeAndWait(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    const systemRoot =
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    await new Promise<void>((resolveDone) => {
      let completed = false;
      let directTermination: NodeJS.Timeout | undefined;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (directTermination) clearTimeout(directTermination);
        resolveDone();
      };
      const killer = spawn(
        join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
          env: backendChildEnvironment(),
        },
      );
      // taskkill occasionally blocks while walking a process tree (notably on
      // hosts with an unhealthy WMI/process provider). Give it time to collect
      // descendants, then terminate the direct compiler process through
      // Node's native process handle so timeout and cancellation remain
      // bounded and the semantic workspace is released.
      directTermination = setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited or taskkill completed first.
        }
      }, 250);
      const timeout = setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
        try {
          killer.kill();
        } catch {
          // The bounded wait remains authoritative.
        }
        finish();
      }, 1_500);
      killer.once("error", finish);
      killer.once("close", finish);
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function backendChildEnvironment(
  gppExecutable?: string,
  semanticTempRoot?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  // STruC++ and generated executables only need the selected compiler's
  // runtime directory. Do not inherit host PATH entries into semantic child
  // processes; bundled and advanced-override compilers are both explicit.
  env[pathKey] = gppExecutable ? dirname(gppExecutable) : "";
  if (semanticTempRoot) env.STRUCPP_TEST_TEMP_ROOT = semanticTempRoot;
  return env;
}

export function classifyBackendRun(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  tests: BackendRunResult["tests"],
): BackendRunResult["status"] {
  const combined = `${stdout}\n${stderr}`;
  if (tests.some((test) => test.status === "failed")) return "failed";
  if (
    /^\s*FAIL:/im.test(combined) ||
    (/Assertion failed/i.test(combined) && exitCode !== 0)
  )
    return "failed";
  if (
    /Error compiling|Compilation failed|syntax|parse|semantic|error:/i.test(
      combined,
    ) &&
    exitCode !== 0
  )
    return "compile_error";
  if (exitCode === 0 && executedTestCount(tests) > 0) return "passed";
  return "backend_error";
}

function executedTestCount(tests: BackendRunResult["tests"]): number {
  return tests.filter(
    (test) => test.status === "passed" || test.status === "failed",
  ).length;
}

function parseTests(text: string): BackendRunResult["tests"] {
  const tests: BackendRunResult["tests"] = [];
  const pendingFailureDetails: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      /^ASSERT_[A-Z_]+\s+failed:/i.test(trimmed) ||
      (pendingFailureDetails.length > 0 && /^at\s+.+:\d+/i.test(trimmed))
    ) {
      pendingFailureDetails.push(trimmed);
      continue;
    }
    const pass = /^\s*(?:PASS:|\[PASS\])\s*(.+?)\s*$/i.exec(line);
    if (pass) {
      pendingFailureDetails.length = 0;
      tests.push({ name: pass[1], status: "passed" });
    }
    const fail = /^\s*(?:FAIL:|\[FAIL\])\s*(.+?)\s*$/i.exec(line);
    if (fail) {
      const message =
        pendingFailureDetails.length > 0
          ? pendingFailureDetails.join("\n")
          : trimmed;
      pendingFailureDetails.length = 0;
      tests.push({ name: fail[1], status: "failed", message });
    }
    const skipped = /^\s*(?:SKIP:|\[SKIP\]|\[SKIPPED\])\s*(.+?)\s*$/i.exec(
      line,
    );
    if (skipped) {
      pendingFailureDetails.length = 0;
      tests.push({ name: skipped[1], status: "skipped" });
    }
  }
  return tests;
}

function parseTestResultLine(
  line: string,
): BackendRunResult["tests"][number] | undefined {
  const pass = /^\s*(?:PASS:|\[PASS\])\s*(.+?)\s*$/i.exec(line);
  if (pass) return { name: pass[1], status: "passed" };
  const fail = /^\s*(?:FAIL:|\[FAIL\])\s*(.+?)\s*$/i.exec(line);
  if (fail) return { name: fail[1], status: "failed" };
  const skipped = /^\s*(?:SKIP:|\[SKIP\]|\[SKIPPED\])\s*(.+?)\s*$/i.exec(line);
  if (skipped) return { name: skipped[1], status: "skipped" };
  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    const result = await stat(path);
    return result.isFile();
  } catch {
    return false;
  }
}

async function tryStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}
