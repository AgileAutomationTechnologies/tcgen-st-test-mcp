import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export type WorkspaceCleanupResult = {
  removed: boolean;
  retained: boolean;
  diagnosticCode?: "SANDBOX_WORKSPACE_CLEANUP_FAILED";
};

type RemoveWorkspace = (
  root: string,
  options: {
    recursive: true;
    force: true;
    maxRetries: number;
    retryDelay: number;
  }
) => Promise<void>;

export class WorkspaceManager {
  constructor(
    private readonly removeWorkspace: RemoveWorkspace = (root, options) => rm(root, options)
  ) {}

  async create(): Promise<string> {
    return mkdtemp(join(tmpdir(), "tcgen-st-test-"));
  }

  async writeFiles(root: string, files: Array<{ path: string; content: string }>): Promise<string[]> {
    const written: string[] = [];
    for (const file of files) {
      const target = safeJoin(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      written.push(target);
    }
    return written;
  }

  async cleanup(root: string, keepWorkspace: boolean): Promise<WorkspaceCleanupResult> {
    if (keepWorkspace) return { removed: false, retained: true };
    try {
      await this.removeWorkspace(root, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 8 : 2,
        retryDelay: 125
      });
      return { removed: true, retained: false };
    } catch {
      // Never expose the machine-local workspace path or mask the semantic
      // verdict. The caller projects the stable code into the report.
      console.warn("[tcgen-st-test] Semantic workspace cleanup failed after bounded retries.");
      return {
        removed: false,
        retained: true,
        diagnosticCode: "SANDBOX_WORKSPACE_CLEANUP_FAILED"
      };
    }
  }
}

function safeJoin(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\") || relativePath.includes("..")) {
    throw new Error(`Unsafe workspace path: ${relativePath}`);
  }
  const target = normalize(join(root, relativePath));
  if (!target.toLowerCase().startsWith(normalize(root).toLowerCase())) {
    throw new Error(`Workspace path escapes root: ${relativePath}`);
  }
  return target;
}

function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}
