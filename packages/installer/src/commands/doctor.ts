import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectClaudePlusPlusLoader } from "../asar.js";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import { discoverClaudeInstall, type ClaudeInstall } from "../platform.js";
import { readClaudePlusPlusState } from "../state.js";
import {
  inspectWatcher,
  type InspectWatcherOptions,
  type WatcherInspection,
} from "../watcher-health.js";
import { resolveInstallerSourceRoot } from "./install.js";
import { getClaudePlusPlusStatus, type AsarProvenance } from "./status.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  discover(): Promise<ClaudeInstall>;
  sourceRoot: string;
  inspectWatcher(options: InspectWatcherOptions): WatcherInspection;
}

export async function doctorClaudePlusPlus(
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  dependencies: Partial<DoctorDeps> = {},
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  try {
    const official = await (dependencies.discover ?? discoverClaudeInstall)();
    checks.push({ name: "official-claude", ok: true, detail: `version ${official.packageVersion}` });
  } catch (error) {
    checks.push({ name: "official-claude", ok: false, detail: errorMessage(error) });
  }

  const state = readClaudePlusPlusState(paths.stateFile);
  checks.push({ name: "state", ok: state !== null, detail: state ? `schema ${state.schemaVersion}` : "missing" });
  checks.push({
    name: "managed-app",
    ok: Boolean(state && existsSync(state.managedExecutable) && existsSync(state.asarPath)),
    detail: state ? `Claude package ${state.packageVersion}` : "unavailable",
  });
  const loader = state ? inspectClaudePlusPlusLoader(state.asarPath) : null;
  checks.push({
    name: "loader",
    ok: loader !== null,
    detail: loader ? `version ${loader.metadata.loaderVersion}` : "missing or invalid",
  });
  const status = getClaudePlusPlusStatus(paths);
  checks.push(asarHashCheck(status.asarProvenance));
  checks.push({ name: "runtime", ok: status.runtimeReady, detail: status.runtimeReady ? "ready" : "missing" });
  const settingsRuntimeReady = existsSync(join(paths.runtime, "main.js")) &&
    existsSync(join(paths.runtime, "preload", "index.js"));
  checks.push({
    name: "settings-runtime",
    ok: settingsRuntimeReady,
    detail: settingsRuntimeReady ? "main and preload ready" : "main or preload missing",
  });
  checks.push({
    name: "integrity-fuse",
    ok: status.integrityFuseReady,
    detail: status.integrityFuseReady ? "disabled in managed executable" : "enabled or unreadable",
  });
  checks.push(configCheck(paths.configFile));
  checks.push(storeCheck(join(dependencies.sourceRoot ?? resolveInstallerSourceRoot(), "store", "index.json")));
  const watcher = (dependencies.inspectWatcher ?? inspectWatcher)({ paths });
  const watcherExpected = state?.watcher === "scheduled-task";
  checks.push({
    name: "watcher",
    ok: !watcherExpected || watcher.installed,
    detail: watcher.installed ? "logon and five-minute tasks ready" : watcherExpected
      ? "configured but incomplete"
      : "optional; not installed",
  });
  checks.push({ name: "safe-mode", ok: true, detail: status.safeMode ? "enabled" : "disabled" });
  return { checks };
}

function asarHashCheck(provenance: AsarProvenance | null): DoctorCheck {
  switch (provenance) {
    case "patched":
      return { name: "asar-hash", ok: true, detail: "matches patched" };
    case "legacy":
      return {
        name: "asar-hash",
        ok: true,
        detail: "not recorded; run repair to establish provenance",
      };
    case "original":
      return { name: "asar-hash", ok: false, detail: "matches original; run repair" };
    case "drift":
      return { name: "asar-hash", ok: false, detail: "drift from original and patched" };
    case "unreadable":
      return { name: "asar-hash", ok: false, detail: "missing or unreadable" };
    default:
      return { name: "asar-hash", ok: false, detail: "unavailable" };
  }
}

function configCheck(path: string): DoctorCheck {
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const valid = isRecord(config) && isRecord(config.claudePlusPlus) && isRecord(config.tweaks) &&
      isRecord(config.tweakUpdateChecks);
    return { name: "config", ok: valid, detail: valid ? "readable current schema" : "invalid shape" };
  } catch (error) {
    return { name: "config", ok: false, detail: errorMessage(error) };
  }
}

function storeCheck(path: string): DoctorCheck {
  try {
    const store = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const valid = isRecord(store) && store.schemaVersion === 1 && Array.isArray(store.entries);
    return { name: "tweak-store", ok: valid, detail: valid ? "schema 1 registry" : "invalid shape" };
  } catch (error) {
    return { name: "tweak-store", ok: false, detail: errorMessage(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
