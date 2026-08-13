import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type UpdateChannel = "stable" | "prerelease" | "custom";

export interface TweakUpdateCheck {
  checkedAt: string;
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  error?: string;
}

export interface ClaudePlusPlusUpdateCheck {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  updateAvailable: boolean;
  error?: string;
}

export interface ClaudePlusPlusConfig extends Record<string, unknown> {
  safeMode: boolean;
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  updateRepo: string;
  updateRef: string;
  updateCheck?: ClaudePlusPlusUpdateCheck;
}

export interface TweakConfig extends Record<string, unknown> {
  enabled?: boolean;
}

export interface RuntimeConfig extends Record<string, unknown> {
  claudePlusPlus: ClaudePlusPlusConfig;
  tweaks: Record<string, TweakConfig>;
  tweakUpdateChecks: Record<string, TweakUpdateCheck>;
}

const defaultClaudePlusPlusConfig: ClaudePlusPlusConfig = {
  safeMode: false,
  autoUpdate: false,
  updateChannel: "stable",
  updateRepo: "kpkhxlgy0/claude-plusplus",
  updateRef: "",
};

export function readRuntimeConfig(path: string): RuntimeConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed)) raw = parsed;
  } catch {}

  const claudePlusPlus = isRecord(raw.claudePlusPlus) ? raw.claudePlusPlus : {};
  const tweaks = isRecord(raw.tweaks) ? raw.tweaks : {};
  const tweakUpdateChecks = isRecord(raw.tweakUpdateChecks) ? raw.tweakUpdateChecks : {};
  return {
    ...raw,
    claudePlusPlus: {
      ...claudePlusPlus,
      safeMode: claudePlusPlus.safeMode === true,
      autoUpdate: claudePlusPlus.autoUpdate === true,
      updateChannel: normalizeUpdateChannel(claudePlusPlus.updateChannel),
      updateRepo: normalizeString(claudePlusPlus.updateRepo, defaultClaudePlusPlusConfig.updateRepo),
      updateRef: normalizeString(claudePlusPlus.updateRef, ""),
      ...(isClaudePlusPlusUpdateCheck(claudePlusPlus.updateCheck)
        ? { updateCheck: claudePlusPlus.updateCheck }
        : {}),
    },
    tweaks: normalizeTweakConfigs(tweaks),
    tweakUpdateChecks: normalizeTweakUpdateChecks(tweakUpdateChecks),
  };
}

export function mutateRuntimeConfig(
  path: string,
  mutate: (config: RuntimeConfig) => void,
): RuntimeConfig {
  const config = readRuntimeConfig(path);
  mutate(config);
  writeRuntimeConfigAtomic(path, config);
  return config;
}

export function isTweakEnabled(config: RuntimeConfig, id: string): boolean {
  return config.tweaks[id]?.enabled !== false;
}

export function setTweakEnabled(path: string, id: string, enabled: boolean): RuntimeConfig {
  return mutateRuntimeConfig(path, (config) => {
    config.tweaks[id] = { ...config.tweaks[id], enabled };
  });
}

function writeRuntimeConfigAtomic(path: string, config: RuntimeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}

function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return value === "prerelease" || value === "custom" ? value : "stable";
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeTweakConfigs(value: Record<string, unknown>): Record<string, TweakConfig> {
  const normalized: Record<string, TweakConfig> = {};
  for (const [id, config] of Object.entries(value)) {
    if (isRecord(config)) normalized[id] = { ...config };
  }
  return normalized;
}

function normalizeTweakUpdateChecks(value: Record<string, unknown>): Record<string, TweakUpdateCheck> {
  const normalized: Record<string, TweakUpdateCheck> = {};
  for (const [id, check] of Object.entries(value)) {
    if (isTweakUpdateCheck(check)) normalized[id] = check;
  }
  return normalized;
}

function isTweakUpdateCheck(value: unknown): value is TweakUpdateCheck {
  if (!isRecord(value)) return false;
  return typeof value.checkedAt === "string" &&
    typeof value.repo === "string" &&
    typeof value.currentVersion === "string" &&
    (typeof value.latestVersion === "string" || value.latestVersion === null) &&
    (typeof value.latestTag === "string" || value.latestTag === null) &&
    (typeof value.releaseUrl === "string" || value.releaseUrl === null) &&
    typeof value.updateAvailable === "boolean" &&
    (value.error === undefined || typeof value.error === "string");
}

function isClaudePlusPlusUpdateCheck(value: unknown): value is ClaudePlusPlusUpdateCheck {
  if (!isRecord(value)) return false;
  return typeof value.checkedAt === "string" &&
    typeof value.currentVersion === "string" &&
    (typeof value.latestVersion === "string" || value.latestVersion === null) &&
    (typeof value.releaseUrl === "string" || value.releaseUrl === null) &&
    (typeof value.releaseNotes === "string" || value.releaseNotes === null) &&
    typeof value.updateAvailable === "boolean" &&
    (value.error === undefined || typeof value.error === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
