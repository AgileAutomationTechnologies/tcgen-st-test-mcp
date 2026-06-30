import { access, stat } from "node:fs/promises";
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

const testedVersion = "0.5.12";
const defaultMsys2Gpp = "C:\\msys64\\ucrt64\\bin\\g++.exe";

export class StrucppBackend {
  async check(): Promise<BackendCheckResult> {
    const diagnostics: Diagnostic[] = [];
    const command = await resolveStrucpp(process.env.STRUCPP_PATH, diagnostics);
    if (!command) {
      return {
        backend: "strucpp",
        available: false,
        testedVersion,
        diagnostics: [diagnostic("error", "STRUCPP_NOT_FOUND", "STruC++ executable was not found via STRUCPP_PATH or PATH.")]
      };
    }

    const version = await runVersion(command, diagnostics);
    const gpp = await resolveGpp(false);
    diagnostics.push(...gpp.diagnostics);
    if (version && !version.includes(testedVersion)) {
      diagnostics.push(diagnostic("warning", "STRUCPP_VERSION_UNTESTED", `STruC++ version '${version}' differs from tested ${testedVersion}.`, { blocking: false }));
    }

    return {
      backend: "strucpp",
      available: true,
      executable: command.executable,
      command: command.command,
      argumentsPrefix: command.argsPrefix,
      cliMode: command.mode,
      version,
      testedVersion,
      gppAvailable: gpp.available,
      gppExecutable: gpp.executable,
      diagnostics
    };
  }

  async run(sourcePaths: string[], testPath: string, options: { timeoutMs?: number } = {}): Promise<BackendRunResult> {
    const diagnostics: Diagnostic[] = [];
    const command = await resolveStrucpp(process.env.STRUCPP_PATH, diagnostics);
    if (!command) {
      return {
        status: "backend_error",
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        diagnostics: [diagnostic("error", "STRUCPP_NOT_FOUND", "STruC++ executable was not found via STRUCPP_PATH or PATH.")],
        tests: []
      };
    }

    const version = await runVersion(command, diagnostics);
    const gpp = await resolveGpp(true);
    diagnostics.push(...gpp.diagnostics);
    if (!gpp.available || !gpp.executable) {
      return {
        status: "backend_error",
        executable: command.executable,
        command: command.command,
        argumentsPrefix: command.argsPrefix,
        cliMode: command.mode,
        version,
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
    const result = await spawnWithTimeout(command, args, timeoutMs, gpp.executable);
    if (result.timedOut) {
      diagnostics.push(diagnostic("error", "SANDBOX_TIMEOUT", `STruC++ timed out after ${timeoutMs} ms.`));
      return {
        status: "timeout",
        executable: command.executable,
        command: command.command,
        argumentsPrefix: command.argsPrefix,
        cliMode: command.mode,
        version,
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
      executable: command.executable,
      command: command.command,
      argumentsPrefix: command.argsPrefix,
      cliMode: command.mode,
      version,
      gppExecutable: gpp.executable,
      durationMs: Date.now() - started,
      diagnostics,
      tests,
      ...result
    };
  }
}

async function resolveStrucpp(explicitPath: string | undefined, diagnostics: Diagnostic[]): Promise<ResolvedCommand | undefined> {
  if (explicitPath?.trim()) {
    const resolved = resolve(explicitPath.trim());
    const resolvedStat = await tryStat(resolved);
    if (resolvedStat?.isDirectory()) {
      const repoCli = join(resolved, "dist", "node", "cli.js");
      if (await fileExists(repoCli)) return nodeCommand(repoCli, resolved);
      const bundledWin = join(resolved, "dist", "bin", "strucpp-win.exe");
      if (await fileExists(bundledWin)) return nativeCommand(bundledWin, resolved);
      diagnostics.push(diagnostic("error", "STRUCPP_PATH_INVALID", `STRUCPP_PATH directory '${resolved}' does not contain dist/node/cli.js or a bundled strucpp executable.`));
      return undefined;
    }

    if (resolvedStat?.isFile()) {
      return isJavaScriptCli(resolved) ? nodeCommand(resolved, inferRepoRootFromCli(resolved)) : nativeCommand(resolved, dirname(resolved));
    }

    diagnostics.push(diagnostic("error", "STRUCPP_PATH_INVALID", `STRUCPP_PATH '${resolved}' does not exist.`));
    return undefined;
  }

  const executable = await locateExecutable("strucpp");
  return executable ? nativeCommand(executable, dirname(executable)) : undefined;
}

async function resolveGpp(forRun: boolean): Promise<ResolvedGpp> {
  const explicit = process.env.STRUCPP_GPP_PATH?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    if (await fileExists(resolved)) return { available: true, executable: resolved, diagnostics: [] };
    return {
      available: false,
      executable: resolved,
      diagnostics: [diagnostic(forRun ? "error" : "warning", "STRUCPP_GPP_PATH_INVALID", `STRUCPP_GPP_PATH '${resolved}' does not exist.`, { blocking: forRun })]
    };
  }

  const pathGpp = await locateExecutable("g++");
  if (pathGpp) return { available: true, executable: pathGpp, diagnostics: [] };

  if (await fileExists(defaultMsys2Gpp)) {
    return { available: true, executable: defaultMsys2Gpp, diagnostics: [] };
  }

  return {
    available: false,
    diagnostics: [
      diagnostic(forRun ? "error" : "warning", "STRUCPP_GPP_NOT_FOUND", "g++ was not found on PATH, STRUCPP_GPP_PATH, or C:\\msys64\\ucrt64\\bin\\g++.exe.", {
        blocking: forRun
      })
    ]
  };
}

function nodeCommand(cliPath: string, cwd?: string): ResolvedCommand {
  return {
    executable: cliPath,
    command: process.execPath,
    argsPrefix: [cliPath],
    mode: "node",
    cwd
  };
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
  for (const key of ["PATH", "Path", "TEMP", "TMP", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (gppExecutable) {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const current = env[key] ?? env.PATH ?? env.Path ?? "";
    env[key] = `${dirname(gppExecutable)}${delimiter}${current}`;
  }
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
