import type {
  TweakApi,
  TweakFs,
  TweakLogger,
  TweakManifest,
  TweakStorage,
} from "@claude-plusplus/sdk";
import { createDiskStorage } from "./storage.js";
import { createTweakFs } from "./tweak-fs.js";
import { createClaudeSessionsApiLease } from "./preload/claude-sessions-adapter.js";
import {
  createMainTweakIpc,
  createRendererTweakIpc,
  type MainTweakIpcBridge,
  type RendererTweakIpcBridge,
} from "./tweak-ipc.js";
import type { TweakApiLease } from "./tweak-lifecycle.js";
import type { StartupEnvironmentService } from "./startup-environment.js";
import type { ClaudeCodeSettingsService } from "./claude-code-settings.js";

export interface MainTweakApiOptions {
  manifest: TweakManifest;
  userRoot: string;
  log: TweakLogger;
  ipc: MainTweakIpcBridge;
  startupEnvironment: StartupEnvironmentService;
  claudeCodeSettings: ClaudeCodeSettingsService;
}

export interface RendererStorageBridge {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RendererTweakApiOptions {
  manifest: TweakManifest;
  log: TweakLogger;
  storage: RendererStorageBridge;
  ipc: RendererTweakIpcBridge;
}

export function createMainTweakApiLease(options: MainTweakApiOptions): TweakApiLease {
  const storage = createDiskStorage(options.userRoot, options.manifest.id);
  const ipc = createMainTweakIpc(options.manifest.id, options.ipc);
  const fs = guardFilesystem(
    createTweakFs(options.userRoot, options.manifest.id),
    options.manifest,
  );
  const startupEnvironment = options.manifest.permissions?.includes("startup-environment")
    ? options.startupEnvironment.createApiLease(options.manifest)
    : undefined;
  const claudeCodeSettings = options.manifest.permissions?.includes("claude-code-settings")
    ? options.claudeCodeSettings.createApiLease(options.manifest)
    : undefined;
  return {
    api: {
      manifest: options.manifest,
      storage,
      log: options.log,
      process: "main",
      ipc: ipc.api,
      fs,
      ...(startupEnvironment ? { startupEnvironment: startupEnvironment.api } : {}),
      ...(claudeCodeSettings ? { claudeCodeSettings: claudeCodeSettings.api } : {}),
    },
    async dispose(): Promise<void> {
      claudeCodeSettings?.dispose();
      startupEnvironment?.dispose();
      try {
        await ipc.dispose();
      } finally {
        storage.dispose();
      }
    },
  };
}

export function createRendererTweakApiLease(options: RendererTweakApiOptions): TweakApiLease {
  const ipc = createRendererTweakIpc(options.manifest.id, options.ipc);
  const fs = guardFilesystem(
    createRendererFs(options.manifest.id, options.ipc),
    options.manifest,
  );
  const claudeSessions = options.manifest.permissions?.includes("claude-sessions")
    ? createClaudeSessionsApiLease(options.ipc)
    : undefined;
  const claude = claudeSessions ? { sessions: claudeSessions.api } : undefined;
  return {
    api: {
      manifest: options.manifest,
      storage: createRendererStorage(options.manifest.id, options.storage),
      log: options.log,
      process: "renderer",
      ipc: ipc.api,
      fs,
      ...(claude ? { claude } : {}),
    },
    async dispose(): Promise<void> {
      claudeSessions?.dispose();
      await ipc.dispose();
    },
  };
}

function createRendererStorage(id: string, bridge: RendererStorageBridge): TweakStorage {
  const key = `claudepp:storage:${id}`;
  const read = (): Record<string, unknown> => {
    try {
      const value = JSON.parse(bridge.getItem(key) ?? "{}") as unknown;
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  };
  const write = (value: Record<string, unknown>): void => {
    bridge.setItem(key, JSON.stringify(value));
  };
  return {
    get<T = unknown>(itemKey: string, fallback?: T): T {
      const data = read();
      return Object.prototype.hasOwnProperty.call(data, itemKey) ? data[itemKey] as T : fallback as T;
    },
    set(itemKey: string, value: unknown): void {
      const data = read();
      data[itemKey] = value;
      write(data);
    },
    delete(itemKey: string): void {
      const data = read();
      delete data[itemKey];
      write(data);
    },
    all(): Record<string, unknown> {
      return { ...read() };
    },
  };
}

function createRendererFs(id: string, bridge: RendererTweakIpcBridge): TweakFs {
  return {
    dataDir: `<remote>/tweak-data/${id}`,
    read: (relPath) => bridge.invoke("claudepp:tweak-fs", id, "read", relPath) as Promise<string>,
    write: (relPath, contents) =>
      bridge.invoke("claudepp:tweak-fs", id, "write", relPath, contents) as Promise<void>,
    exists: (relPath) => bridge.invoke("claudepp:tweak-fs", id, "exists", relPath) as Promise<boolean>,
  };
}

function guardFilesystem(fs: TweakFs, manifest: TweakManifest): TweakFs {
  const check = (): void => {
    if (!manifest.permissions?.includes("filesystem")) {
      throw new Error("Tweak requires filesystem permission");
    }
  };
  return {
    dataDir: fs.dataDir,
    async read(relPath): Promise<string> {
      check();
      return await fs.read(relPath);
    },
    async write(relPath, contents): Promise<void> {
      check();
      await fs.write(relPath, contents);
    },
    async exists(relPath): Promise<boolean> {
      check();
      return await fs.exists(relPath);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
