import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export class WorkspaceManager {
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

  async cleanup(root: string, keepWorkspace: boolean): Promise<void> {
    if (keepWorkspace) return;
    await rm(root, { recursive: true, force: true });
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
