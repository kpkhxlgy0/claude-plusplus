import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TweakStorage } from "@claude-plusplus/sdk";

export interface DiskStorage extends TweakStorage {
  flush(): void;
  dispose(): void;
}

const FLUSH_DELAY_MS = 50;

export function createDiskStorage(userRoot: string, id: string): DiskStorage {
  const dir = join(userRoot, "storage");
  const file = join(dir, `${sanitize(id)}.json`);
  mkdirSync(dir, { recursive: true });

  let data = readStorage(file);
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (!dirty) return;
    const temporary = `${file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data, null, 2), "utf8");
      renameSync(temporary, file);
      dirty = false;
    } catch (error) {
      console.error("[Claude++] storage flush failed", id, error);
    }
  };

  const scheduleFlush = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, FLUSH_DELAY_MS);
    timer.unref();
  };

  return {
    get<T = unknown>(key: string, fallback?: T): T {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] as T : fallback as T;
    },
    set(key: string, value: unknown): void {
      data[key] = value;
      scheduleFlush();
    },
    delete(key: string): void {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return;
      delete data[key];
      scheduleFlush();
    },
    all(): Record<string, unknown> {
      return { ...data };
    },
    flush,
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      flush();
    },
  };
}

function readStorage(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return {};
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._@-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
