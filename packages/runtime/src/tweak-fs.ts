import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import type { TweakFs } from "@claude-plusplus/sdk";

export function createTweakFs(userRoot: string, id: string): TweakFs {
  const dataDir = join(userRoot, "tweak-data", sanitize(id));
  return {
    dataDir,
    async read(relPath: string): Promise<string> {
      return await readFile(resolveTweakDataPath(dataDir, relPath), "utf8");
    },
    async write(relPath: string, contents: string): Promise<void> {
      const path = resolveTweakDataPath(dataDir, relPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    },
    async exists(relPath: string): Promise<boolean> {
      try {
        await access(resolveTweakDataPath(dataDir, relPath));
        return true;
      } catch (error) {
        if (isMissingPathError(error)) return false;
        throw error;
      }
    },
  };
}

export function resolveTweakDataPath(dataDir: string, relPath: string): string {
  if (typeof relPath !== "string" || /[\u0000-\u001f\u007f]/.test(relPath)) {
    throw new Error("Tweak filesystem invalid path");
  }
  if (win32.isAbsolute(relPath)) throw new Error("Tweak filesystem path must be a relative path");
  const root = win32.resolve(dataDir);
  const candidate = win32.resolve(root, relPath);
  const prefix = `${root.replace(/[\\/]+$/, "")}\\`;
  if (candidate !== root && !candidate.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error("Tweak filesystem path is outside tweak data directory");
  }
  return candidate;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._@-]/g, "_");
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
