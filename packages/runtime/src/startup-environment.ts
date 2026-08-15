import { join } from "node:path";
import type {
  StartupEnvironmentApi,
  StartupEnvironmentConfig,
  StartupEnvironmentStatus,
  TweakLogger,
  TweakManifest,
} from "@claude-plusplus/sdk";
import { isTweakEnabled, readRuntimeConfig } from "./config.js";
import {
  readStartupEnvironmentSnapshot,
  writeStartupEnvironmentSnapshot,
} from "./startup-environment-store.js";
import { discoverTweaks } from "./tweak-discovery.js";

export interface StartupEnvironmentAppBridge {
  relaunch(): void;
  quit(): void;
}

export interface StartupEnvironmentApiLease {
  api: StartupEnvironmentApi;
  dispose(): void;
}

export interface StartupEnvironmentService {
  createApiLease(manifest: TweakManifest): StartupEnvironmentApiLease;
  getStatus(id: string): StartupEnvironmentStatus;
  attachAppBridge(app: StartupEnvironmentAppBridge): void;
  restoreBaseline(): void;
}

interface StatusRecord {
  manifest: TweakManifest;
  saved: StartupEnvironmentConfig | null;
  applied: StartupEnvironmentConfig | null;
  error?: string;
}

interface BaselineValue {
  present: boolean;
  value: string | undefined;
}

interface AppliedGroup {
  manifest: TweakManifest;
  config: StartupEnvironmentConfig;
  baseline: Map<string, BaselineValue>;
}

interface Candidate {
  manifest: TweakManifest;
  config: StartupEnvironmentConfig;
  status: StatusRecord;
}

export function initializeStartupEnvironment(options: {
  userRoot: string;
  env: NodeJS.ProcessEnv;
  log: TweakLogger;
  app?: StartupEnvironmentAppBridge;
}): StartupEnvironmentService {
  const service = new StartupEnvironmentServiceImpl(options);
  service.initialize();
  return service;
}

class StartupEnvironmentServiceImpl implements StartupEnvironmentService {
  private readonly statuses = new Map<string, StatusRecord>();
  private readonly appliedGroups: AppliedGroup[] = [];
  private app?: StartupEnvironmentAppBridge;
  private initializationError?: string;

  public constructor(private readonly options: {
    userRoot: string;
    env: NodeJS.ProcessEnv;
    log: TweakLogger;
    app?: StartupEnvironmentAppBridge;
  }) {
    this.app = options.app;
  }

  public initialize(): void {
    try {
      const config = readRuntimeConfig(join(this.options.userRoot, "config.json"));
      if (config.claudePlusPlus.safeMode) return;
      const discovered = discoverTweaks(
        join(this.options.userRoot, "tweaks"),
        "main",
        (message) => this.writeLog("warn", message),
      );
      const candidates: Candidate[] = [];
      for (const item of discovered) {
        const snapshot = readStartupEnvironmentSnapshot(this.options.userRoot, item.manifest);
        const status: StatusRecord = {
          manifest: item.manifest,
          saved: cloneConfig(snapshot.config),
          applied: null,
          ...(snapshot.error ? { error: snapshot.error } : {}),
        };
        this.statuses.set(item.manifest.id, status);
        if (snapshot.error) {
          this.writeLog("warn", `${item.manifest.id}: ${snapshot.error}`);
          continue;
        }
        if (!snapshot.config || !isTweakEnabled(config, item.manifest.id)) continue;
        if (!snapshot.config.enabled) {
          status.applied = cloneConfig(snapshot.config);
          continue;
        }
        candidates.push({ manifest: item.manifest, config: snapshot.config, status });
      }
      const conflicts = findConflicts(candidates);
      for (const candidate of candidates) {
        const conflict = conflicts.get(candidate.manifest.id);
        if (conflict) {
          candidate.status.error = conflict;
          this.writeLog("warn", conflict);
          continue;
        }
        this.applyCandidate(candidate);
      }
    } catch (error) {
      this.restoreBaseline();
      this.initializationError = errorMessage(error);
      for (const status of this.statuses.values()) {
        status.applied = null;
        status.error = this.initializationError;
      }
      this.writeLog("error", `Startup environment bridge failed: ${this.initializationError}`);
    }
  }

  public createApiLease(manifest: TweakManifest): StartupEnvironmentApiLease {
    assertManifestPermission(manifest);
    this.ensureStatus(manifest);
    let disposed = false;
    const guard = (): void => {
      if (disposed) throw new Error(`Startup environment API for ${manifest.id} is disposed`);
    };
    return {
      api: {
        getStatus: () => {
          guard();
          return this.getStatus(manifest.id);
        },
        save: (config) => {
          guard();
          writeStartupEnvironmentSnapshot(this.options.userRoot, manifest, config);
          const saved = normalizeConfig(manifest, config);
          const status = this.statuses.get(manifest.id) as StatusRecord;
          status.saved = saved;
          delete status.error;
          return publicStatus(status);
        },
        relaunch: () => {
          guard();
          this.relaunch();
        },
      },
      dispose() {
        disposed = true;
      },
    };
  }

  public getStatus(id: string): StartupEnvironmentStatus {
    const status = this.statuses.get(id);
    if (status) return publicStatus(status);
    return {
      saved: null,
      applied: null,
      restartRequired: false,
      ...(this.initializationError ? { error: this.initializationError } : {}),
    };
  }

  public attachAppBridge(app: StartupEnvironmentAppBridge): void {
    if (this.app === app) return;
    if (this.app) throw new Error("Startup environment app bridge is already attached");
    this.app = app;
  }

  public restoreBaseline(): void {
    for (const group of [...this.appliedGroups].reverse()) {
      restoreValues(this.options.env, group.baseline);
    }
  }

  private ensureStatus(manifest: TweakManifest): void {
    if (this.statuses.has(manifest.id)) return;
    const snapshot = readStartupEnvironmentSnapshot(this.options.userRoot, manifest);
    this.statuses.set(manifest.id, {
      manifest,
      saved: cloneConfig(snapshot.config),
      applied: null,
      ...(snapshot.error ? { error: snapshot.error } : {}),
    });
  }

  private applyCandidate(candidate: Candidate): void {
    const keys = candidate.manifest.startupEnvironment?.keys ?? [];
    const baseline = new Map<string, BaselineValue>();
    try {
      for (const key of keys) {
        baseline.set(key, {
          present: Object.prototype.hasOwnProperty.call(this.options.env, key),
          value: this.options.env[key],
        });
      }
      for (const key of keys) this.options.env[key] = candidate.config.variables[key];
    } catch {
      restoreValues(this.options.env, baseline);
      candidate.status.error = `Failed to apply startup environment keys ${keys.join(", ")} for ${candidate.manifest.id}`;
      this.writeLog("error", candidate.status.error);
      return;
    }
    const config = cloneConfig(candidate.config) as StartupEnvironmentConfig;
    candidate.status.applied = config;
    this.appliedGroups.push({ manifest: candidate.manifest, config, baseline });
  }

  private relaunch(): void {
    if (!this.app) throw new Error("Startup environment relaunch is unavailable");
    this.restoreBaseline();
    try {
      this.app.relaunch();
      this.app.quit();
    } catch (error) {
      this.reapplyOverlays();
      throw error;
    }
  }

  private reapplyOverlays(): void {
    try {
      for (const group of this.appliedGroups) {
        for (const key of group.manifest.startupEnvironment?.keys ?? []) {
          this.options.env[key] = group.config.variables[key];
        }
      }
    } catch (error) {
      this.restoreBaseline();
      this.writeLog("error", `Failed to restore startup environment after relaunch failure: ${errorMessage(error)}`);
    }
  }

  private writeLog(level: keyof TweakLogger, message: string): void {
    try {
      this.options.log[level](message);
    } catch {}
  }
}

function findConflicts(candidates: readonly Candidate[]): Map<string, string> {
  const owners = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const key of candidate.manifest.startupEnvironment?.keys ?? []) {
      const ids = owners.get(key) ?? [];
      ids.push(candidate.manifest.id);
      owners.set(key, ids);
    }
  }
  const messages = new Map<string, string[]>();
  for (const [key, ids] of owners) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    const message = `Startup environment key conflict: ${key} is declared by ${sorted.join(", ")}`;
    for (const id of sorted) {
      const current = messages.get(id) ?? [];
      current.push(message);
      messages.set(id, current);
    }
  }
  return new Map([...messages].map(([id, values]) => [id, values.join("; ")]));
}

function assertManifestPermission(manifest: TweakManifest): void {
  if (!manifest.permissions?.includes("startup-environment") || !manifest.startupEnvironment?.keys.length) {
    throw new Error(`Tweak ${manifest.id} does not have startup environment permission`);
  }
  if (manifest.scope === "renderer") {
    throw new Error(`Tweak ${manifest.id} is not Main-capable`);
  }
}

function normalizeConfig(
  manifest: TweakManifest,
  config: StartupEnvironmentConfig,
): StartupEnvironmentConfig {
  const keys = manifest.startupEnvironment?.keys ?? [];
  return {
    enabled: config.enabled,
    variables: Object.fromEntries(keys.map((key) => [key, config.variables[key]])),
  };
}

function publicStatus(status: StatusRecord): StartupEnvironmentStatus {
  const saved = cloneConfig(status.saved);
  const applied = cloneConfig(status.applied);
  return {
    saved,
    applied,
    restartRequired: !configsEqual(saved, applied),
    ...(status.error ? { error: status.error } : {}),
  };
}

function cloneConfig(config: StartupEnvironmentConfig | null): StartupEnvironmentConfig | null {
  if (!config) return null;
  return { enabled: config.enabled, variables: { ...config.variables } };
}

function configsEqual(
  left: StartupEnvironmentConfig | null,
  right: StartupEnvironmentConfig | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.enabled !== right.enabled) return false;
  const leftKeys = Object.keys(left.variables).sort();
  const rightKeys = Object.keys(right.variables).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left.variables[key] === right.variables[key]);
}

function restoreValues(env: NodeJS.ProcessEnv, baseline: ReadonlyMap<string, BaselineValue>): void {
  for (const [key, value] of baseline) {
    if (value.present) env[key] = value.value;
    else delete env[key];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
