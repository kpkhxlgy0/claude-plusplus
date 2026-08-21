import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

interface ClaudePlusPlusStateBase {
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

export interface ClaudePlusPlusStateV1 extends ClaudePlusPlusStateBase {
  schemaVersion: 1;
}

export interface ClaudePlusPlusStateV2 extends ClaudePlusPlusStateBase {
  schemaVersion: 2;
  originalAsarHash: string;
  patchedAsarHash: string;
}

export type ClaudePlusPlusState = ClaudePlusPlusStateV1 | ClaudePlusPlusStateV2;

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
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)) return null;
    const common = readClaudePlusPlusStateBase(parsed);
    if (!common) return null;
    if (parsed.schemaVersion === 1) return { schemaVersion: 1, ...common };
    if (!isLowercaseSha256(parsed.originalAsarHash) || !isLowercaseSha256(parsed.patchedAsarHash)) {
      return null;
    }
    return {
      schemaVersion: 2,
      ...common,
      originalAsarHash: parsed.originalAsarHash,
      patchedAsarHash: parsed.patchedAsarHash,
    };
  } catch {
    return null;
  }
}

export function isClaudePlusPlusStateV2(
  state: ClaudePlusPlusState | null,
): state is ClaudePlusPlusStateV2 {
  return state?.schemaVersion === 2;
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

function readClaudePlusPlusStateBase(
  value: Record<string, unknown>,
): ClaudePlusPlusStateBase | null {
  if (
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
    claudePlusPlusVersion: value.claudePlusPlusVersion,
    packageFullName: value.packageFullName,
    packageVersion: value.packageVersion,
    officialAppRoot: value.officialAppRoot,
    managedAppRoot: value.managedAppRoot,
    managedExecutable: value.managedExecutable,
    asarPath: value.asarPath,
    originalMain: value.originalMain,
    installedAt: value.installedAt,
    watcher: value.watcher === "scheduled-task" ? "scheduled-task" : "none",
  };
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
