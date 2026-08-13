import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface ClaudePlusPlusState {
  schemaVersion: 1;
  claudePlusPlusVersion: string;
  packageFullName: string;
  packageVersion: string;
  officialAppRoot: string;
  managedAppRoot: string;
  managedExecutable: string;
  asarPath: string;
  originalMain: string;
  installedAt: string;
  watcher?: "scheduled-task" | "none";
}

export type SelfUpdateChannel = "stable" | "prerelease" | "custom";
export type SelfUpdateStatus = "checking" | "up-to-date" | "updated" | "failed" | "disabled";

export interface SelfUpdateState {
  checkedAt: string;
  completedAt?: string;
  status: SelfUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  targetRef: string | null;
  releaseUrl: string | null;
  repo: string;
  channel: SelfUpdateChannel;
  sourceRoot: string;
  sourceLabel: string;
  error?: string;
}

export function readClaudePlusPlusState(path: string): ClaudePlusPlusState | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudePlusPlusState>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.claudePlusPlusVersion !== "string" ||
      typeof value.packageFullName !== "string" ||
      typeof value.packageVersion !== "string" ||
      typeof value.officialAppRoot !== "string" ||
      typeof value.managedAppRoot !== "string" ||
      typeof value.managedExecutable !== "string" ||
      typeof value.asarPath !== "string" ||
      typeof value.originalMain !== "string" ||
      typeof value.installedAt !== "string"
    ) {
      return null;
    }
    return {
      ...value,
      watcher: value.watcher === "scheduled-task" ? "scheduled-task" : "none",
    } as ClaudePlusPlusState;
  } catch {
    return null;
  }
}

export function writeClaudePlusPlusState(path: string, state: ClaudePlusPlusState): void {
  writeJsonAtomic(path, state);
}

export function readSelfUpdateState(path: string): SelfUpdateState | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SelfUpdateState>;
    if (typeof value.checkedAt !== "string" || typeof value.status !== "string" ||
      typeof value.currentVersion !== "string" || typeof value.repo !== "string" ||
      typeof value.channel !== "string" || typeof value.sourceRoot !== "string") return null;
    return value as SelfUpdateState;
  } catch {
    return null;
  }
}

export function writeSelfUpdateState(path: string, state: SelfUpdateState): void {
  writeJsonAtomic(path, state);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
