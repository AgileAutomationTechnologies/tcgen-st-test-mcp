import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BackendCheckResult, Diagnostic, diagnostic } from "../domain/models.js";

export interface BackendRunResult {
  status: "passed" | "failed" | "compile_error" | "backend_error" | "timeout";
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
  tests: Array<{ name: string; status: "passed" | "failed" | "skipped"; message?: string }>;
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
};

const testedVersion = "0.5.12";
const developmentMsys2Gpp = "C:\\msys64\\ucrt64\\bin\\g++.exe";
const bundledStrucppRelativePath = join("backend", "strucpp-win.exe");
const bundledGppRelativePath = join("toolchain", "mingw64", "bin", "g++.exe");

export class StrucppBackend {
  async check(): Promise<BackendCheckResult> {
    const diagnostics: Diagnostic[] = [];
    const backend = await resolveCompatibleStrucpp(diagnostics);
    if (!backend) {
      return {
        backend: "strucpp",
        available: false,
        testedVersion,
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [diagnostic("error", "STRUCPP_NOT_FOUND", "STruC++ executable was not found via STRUCPP_PATH or PATH.")]
      };
    }

    const gpp = await resolveCompatibleGpp(true);
    diagnostics.push(...gpp.diagnostics);
    const runtimeIntegrity = await verifyRuntimeManifest(diagnostics);

    return {
      backend: "strucpp",
      available: runtimeIntegrity && gpp.available,
      executable: backend.command.executable,
      command: backend.command.command,
      argumentsPrefix: backend.command.argsPrefix,
      cliMode: backend.command.mode,
      version: backend.version,
      testedVersion,
      gppAvailable: gpp.available,
      gppExecutable: gpp.executable,
      diagnostics
    };
  }

  async run(sourcePaths: string[], testPath: string, options: { timeoutMs?: number } = {}): Promise<BackendRunResult> {
    const diagnostics: Diagnostic[] = [];
    const backend = await resolveCompatibleStrucpp(diagnostics);
    if (!backend) {
      return {
        status: "backend_error",
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [diagnostic("error", "STRUCPP_NOT_FOUND", "STruC++ executable was not found via STRUCPP_PATH or PATH.")],
        tests: []
      };
    }

    if (!(await verifyRuntimeManifest(diagnostics))) {
      return {
        status: "backend_error",
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
        tests: []
      };
    }
    const gpp = await resolveCompatibleGpp(true);
    diagnostics.push(...gpp.diagnostics);
    if (!gpp.available || !gpp.executable) {
      return {
        status: "backend_error",
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
        tests: []
      };
    }

    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 120_000);
    const args = [...sourcePaths, "--gpp", gpp.executable, "--test", testPath];
    const started = Date.now();
    const result = await spawnWithTimeout(backend.command, args, timeoutMs, gpp.executable);
    if (result.timedOut) {
      diagnostics.push(diagnostic("error", "SANDBOX_TIMEOUT", `STruC++ timed out after ${timeoutMs} ms.`));
      return {
        status: "timeout",
        executable: backend.command.executable,
        command: backend.command.command,
        argumentsPrefix: backend.command.argsPrefix,
        cliMode: backend.command.mode,
        version: backend.version,
        gppExecutable: gpp.executable,
        durationMs: Date.now() - started,
        diagnostics,
        tests: [],
        ...result
      };
    }

    const tests = parseTests(result.stdout + "\n" + result.stderr);
    const status = classify(result.exitCode, result.stdout, result.stderr, tests);
    return {
      status,
      executable: backend.command.executable,
      command: backend.command.command,
      argumentsPrefix: backend.command.argsPrefix,
      cliMode: backend.command.mode,
      version: backend.version,
      gppExecutable: gpp.executable,
      durationMs: Date.now() - started,
      diagnostics,
      tests,
      ...result
    };
  }
}

function validateTestedVersion(version: string | undefined, diagnostics: Diagnostic[]): version is string {
  if (!version) {
    diagnostics.push(
      diagnostic("error", "STRUCPP_VERSION_UNVERIFIED", `STruC++ ${testedVersion} is required, but the backend version could not be verified.`)
    );
    return false;
  }
  const detected = /\b\d+\.\d+\.\d+\b/.exec(version)?.[0];
  if (detected === testedVersion) return true;
  diagnostics.push(
    diagnostic(
      "error",
      "STRUCPP_VERSION_MISMATCH",
      `STruC++ version '${version}' is not accepted; this semantic runner is pinned to ${testedVersion}.`
    )
  );
  return false;
}

async function resolveCompatibleStrucpp(diagnostics: Diagnostic[]): Promise<ResolvedBackend | undefined> {
  const explicitPath = process.env.STRUCPP_PATH?.trim();
  if (explicitPath) {
    const overrideDiagnostics: Diagnostic[] = [];
    const override = await resolveStrucppPath(explicitPath, overrideDiagnostics);
    if (override) {
      const version = await runVersion(override, overrideDiagnostics);
      const detected = version && /\b\d+\.\d+\.\d+\b/.exec(version)?.[0];
      if (detected === testedVersion) {
        diagnostics.push(...overrideDiagnostics);
        return { command: override, version: version! };
      }
      diagnostics.push(
        diagnostic(
          "warning",
          "STRUCPP_OVERRIDE_VERSION_MISMATCH",
          `Configured STruC++ '${explicitPath}' reports '${version ?? "unknown"}', not ${testedVersion}; falling back to the bundled runtime.`,
          { blocking: false }
        )
      );
    } else {
      diagnostics.push(...overrideDiagnostics.map(item => ({ ...item, severity: "warning" as const, blocking: false })));
    }
  }

  const bundledPath = resolvePackFile(bundledStrucppRelativePath);
  if (bundledPath && (await fileExists(bundledPath))) {
    const command = nativeCommand(bundledPath, dirname(bundledPath));
    const version = await runVersion(command, diagnostics);
    if (validateTestedVersion(version, diagnostics)) return { command, version };
    return undefined;
  }

  if (!explicitPath) {
    diagnostics.push(diagnostic("error", "STRUCPP_NOT_FOUND", "Bundled STruC++ 0.5.12 is missing. Run TcGen installer Repair."));
  } else {
    diagnostics.push(diagnostic("error", "STRUCPP_BUNDLED_FALLBACK_MISSING", "The configured STruC++ override is incompatible and the bundled runtime is missing. Run TcGen installer Repair."));
  }
  return undefined;
}

async function resolveStrucppPath(explicitPath: string, diagnostics: Diagnostic[]): Promise<ResolvedCommand | undefined> {
  if (explicitPath?.trim()) {
    const resolved = resolve(explicitPath.trim());
    const resolvedStat = await tryStat(resolved);
    if (resolvedStat?.isDirectory()) {
      const bundledWin = join(resolved, "dist", "bin", "strucpp-win.exe");
      if (await fileExists(bundledWin)) return nativeCommand(bundledWin, resolved);
      const repoCli = join(resolved, "dist", "node", "cli.js");
      if (await fileExists(repoCli)) return resolveNodeCommand(repoCli, resolved, diagnostics);
      diagnostics.push(diagnostic("error", "STRUCPP_PATH_INVALID", `STRUCPP_PATH directory '${resolved}' does not contain dist/node/cli.js or a bundled strucpp executable.`));
      return undefined;
    }

    if (resolvedStat?.isFile()) {
      return isJavaScriptCli(resolved)
        ? resolveNodeCommand(resolved, inferRepoRootFromCli(resolved), diagnostics)
        : nativeCommand(resolved, dirname(resolved));
    }

    diagnostics.push(diagnostic("error", "STRUCPP_PATH_INVALID", `STRUCPP_PATH '${resolved}' does not exist.`));
    return undefined;
  }

  return undefined;
}

async function resolveGpp(forRun: boolean): Promise<ResolvedGpp> {
  const explicit = process.env.STRUCPP_GPP_PATH?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    if (await fileExists(resolved)) return { available: true, executable: resolved, diagnostics: [] };
    const bundled = resolvePackFile(bundledGppRelativePath);
    if (bundled && (await fileExists(bundled))) {
      return {
        available: true,
        executable: bundled,
        diagnostics: [diagnostic("warning", "STRUCPP_GPP_PATH_INVALID", `Configured compiler '${resolved}' does not exist; using the bundled compiler.`, { blocking: false })]
      };
    }
    return {
      available: false,
      executable: resolved,
      diagnostics: [diagnostic(forRun ? "error" : "warning", "STRUCPP_GPP_PATH_INVALID", `Configured compiler '${resolved}' does not exist and the bundled compiler is missing. Run TcGen installer Repair.`, { blocking: forRun })]
    };
  }

  const bundled = resolvePackFile(bundledGppRelativePath);
  if (bundled && (await fileExists(bundled))) return { available: true, executable: bundled, diagnostics: [] };

  // Source-checkout development remains convenient; packaged runtimes never consult global PATH.
  if (!packRoot()) {
    const developmentGpp = await locateExecutable("g++");
    if (developmentGpp) return { available: true, executable: developmentGpp, diagnostics: [] };
    if (await fileExists(developmentMsys2Gpp)) return { available: true, executable: developmentMsys2Gpp, diagnostics: [] };
  }

  return {
    available: false,
    diagnostics: [
      diagnostic(forRun ? "error" : "warning", "STRUCPP_GPP_NOT_FOUND", "The bundled C++ compiler is missing. Run TcGen installer Repair, or configure an advanced compiler override.", {
        blocking: forRun
      })
    ]
  };
}

async function resolveCompatibleGpp(forRun: boolean): Promise<ResolvedGpp> {
  const selected = await resolveGpp(forRun);
  if (!selected.available || !selected.executable) return selected;

  const validationDiagnostics: Diagnostic[] = [];
  if (await verifyCpp17Compiler(selected.executable, validationDiagnostics)) return selected;

  const explicit = process.env.STRUCPP_GPP_PATH?.trim();
  const bundled = resolvePackFile(bundledGppRelativePath);
  if (explicit && bundled && (await fileExists(bundled)) && !samePath(selected.executable, bundled)) {
    const bundledDiagnostics: Diagnostic[] = [];
    if (await verifyCpp17Compiler(bundled, bundledDiagnostics)) {
      return {
        available: true,
        executable: bundled,
        diagnostics: [
          ...selected.diagnostics,
          ...validationDiagnostics.map(item => ({ ...item, severity: "warning" as const, blocking: false })),
          diagnostic("warning", "STRUCPP_GPP_OVERRIDE_INCOMPATIBLE", `Configured compiler '${selected.executable}' failed the C++17 self-test; using the bundled compiler.`, { blocking: false })
        ]
      };
    }
    validationDiagnostics.push(...bundledDiagnostics);
  }

  return { available: false, executable: selected.executable, diagnostics: [...selected.diagnostics, ...validationDiagnostics] };
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

async function verifyRuntimeManifest(diagnostics: Diagnostic[]): Promise<boolean> {
  const root = packRoot();
  if (!root) return true;
  const manifestPath = join(root, "runtime-manifest.json");
  try {
    const manifestText = (await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, "");
    const manifest = JSON.parse(manifestText) as {
      files?: Array<{ path?: string; sha256?: string }>;
    };
    const criticalPaths = new Set([
      "runtime/tcgen-st-test-mcp.exe",
      "backend/strucpp-win.exe",
      "toolchain/mingw64/bin/g++.exe"
    ]);
    for (const entry of manifest.files ?? []) {
      const normalized = (entry.path ?? "").replace(/\\/g, "/");
      if (!criticalPaths.has(normalized)) continue;
      const fullPath = join(root, ...normalized.split("/"));
      const actual = createHash("sha256").update(await readFile(fullPath)).digest("hex");
      if (actual.toLowerCase() !== (entry.sha256 ?? "").toLowerCase()) {
        diagnostics.push(diagnostic("error", "RUNTIME_INTEGRITY_FAILED", `Virtual Tests runtime integrity failed for '${normalized}'. Run TcGen installer Repair.`));
        return false;
      }
      criticalPaths.delete(normalized);
    }
    if (criticalPaths.size > 0) throw new Error(`manifest is missing ${[...criticalPaths].join(", ")}`);
    return true;
  } catch (error) {
    diagnostics.push(diagnostic("error", "RUNTIME_MANIFEST_INVALID", `Virtual Tests runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}. Run TcGen installer Repair.`));
    return false;
  }
}

async function verifyCpp17Compiler(executable: string, diagnostics: Diagnostic[]): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "tcgen-cpp17-check-"));
  const source = join(directory, "self-test.cpp");
  const output = join(directory, process.platform === "win32" ? "self-test.exe" : "self-test");
  try {
    await writeFile(source, "#include <iostream>\nint main(){ if constexpr (true) { std::cout << \"tcgen-cpp17-ok\"; } }\n", "utf8");
    const compiler = nativeCommand(executable, directory);
    const compile = await spawnWithTimeout(compiler, ["-std=c++17", source, "-o", output], 15_000, executable);
    if (compile.exitCode !== 0) {
      diagnostics.push(diagnostic("error", "CPP17_COMPILE_FAILED", `The configured C++ compiler failed the C++17 self-test: ${compile.stderr.trim() || "unknown compiler error"}. Run TcGen installer Repair.`));
      return false;
    }
    const run = await spawnWithTimeout(nativeCommand(output, directory), [], 5_000, executable);
    if (run.exitCode !== 0 || !run.stdout.includes("tcgen-cpp17-ok")) {
      diagnostics.push(diagnostic("error", "CPP17_EXECUTION_FAILED", "The compiled C++17 self-test did not run successfully. Run TcGen installer Repair."));
      return false;
    }
    return true;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function resolveNodeCommand(
  cliPath: string,
  cwd: string | undefined,
  diagnostics: Diagnostic[]
): Promise<ResolvedCommand | undefined> {
  let nodeExecutable = process.execPath;
  if (isPackagedRuntime()) {
    const explicit = process.env.TCGEN_ST_NODE_PATH?.trim();
    if (explicit) {
      const resolved = resolve(explicit);
      if (!(await fileExists(resolved)) || samePath(resolved, process.execPath)) {
        diagnostics.push(
          diagnostic("error", "TCGEN_ST_NODE_PATH_INVALID", `TCGEN_ST_NODE_PATH '${resolved}' does not identify an external Node.js executable.`)
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
            "The standalone MCP executable cannot launch a JavaScript STruC++ CLI through itself. Configure TCGEN_ST_NODE_PATH, add an external Node.js executable to PATH, or point STRUCPP_PATH at native strucpp-win.exe."
          )
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
    cwd
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
    cwd
  };
}

function isJavaScriptCli(path: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
}

function inferRepoRootFromCli(cliPath: string): string {
  const normalized = cliPath.replace(/\\/g, "/");
  if (normalized.endsWith("/dist/node/cli.js")) return resolve(cliPath, "..", "..", "..");
  return dirname(cliPath);
}

async function locateExecutable(name: string): Promise<string | undefined> {
  const paths = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const path of paths) {
    for (const candidate of candidates) {
      const full = join(path, candidate);
      if (await fileExists(full)) return full;
    }
  }
  return undefined;
}

async function runVersion(command: ResolvedCommand, diagnostics: Diagnostic[]): Promise<string | undefined> {
  const result = await spawnWithTimeout(command, ["--version"], 5_000);
  if (result.exitCode !== 0) {
    diagnostics.push(diagnostic("warning", "STRUCPP_VERSION_FAILED", "Could not read STruC++ version.", { blocking: false }));
    return undefined;
  }
  return (result.stdout || result.stderr).trim();
}

function spawnWithTimeout(
  command: ResolvedCommand,
  args: string[],
  timeoutMs: number,
  gppExecutable?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }> {
  return new Promise(resolveResult => {
    let settled = false;
    const child = spawn(command.command, [...command.argsPrefix, ...args], {
      shell: false,
      windowsHide: true,
      cwd: command.cwd,
      env: allowedEnv(gppExecutable)
    });
    let stdout = "";
    let stderr = "";
    const finish = (result: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      finish({ stdout, stderr: stderr + error.message, exitCode: null });
    });
    child.on("close", code => {
      finish({ stdout, stderr, exitCode: code });
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
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

function allowedEnv(gppExecutable?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["TEMP", "TMP", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env.PATH ?? process.env.Path ?? "";
  env[pathKey] = gppExecutable ? `${dirname(gppExecutable)}${delimiter}${currentPath}` : currentPath;
  return env;
}

function classify(exitCode: number | null, stdout: string, stderr: string, tests: BackendRunResult["tests"]): BackendRunResult["status"] {
  const combined = `${stdout}\n${stderr}`;
  if (tests.some(test => test.status === "failed")) return "failed";
  if (/^\s*FAIL:/im.test(combined) || (/Assertion failed/i.test(combined) && exitCode !== 0)) return "failed";
  if (/Error compiling|Compilation failed|syntax|parse|semantic|error:/i.test(combined) && exitCode !== 0) return "compile_error";
  if (exitCode === 0) return "passed";
  return "backend_error";
}

function parseTests(text: string): BackendRunResult["tests"] {
  const tests: BackendRunResult["tests"] = [];
  const pendingFailureDetails: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^ASSERT_[A-Z_]+\s+failed:/i.test(trimmed) || (pendingFailureDetails.length > 0 && /^at\s+.+:\d+/i.test(trimmed))) {
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
      const message = pendingFailureDetails.length > 0 ? pendingFailureDetails.join("\n") : trimmed;
      pendingFailureDetails.length = 0;
      tests.push({ name: fail[1], status: "failed", message });
    }
    const skipped = /^\s*(?:SKIP:|\[SKIP\]|\[SKIPPED\])\s*(.+?)\s*$/i.exec(line);
    if (skipped) {
      pendingFailureDetails.length = 0;
      tests.push({ name: skipped[1], status: "skipped" });
    }
  }
  return tests;
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
