import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  injectClaudePlusPlusLoader,
  inspectClaudePlusPlusLoader,
} from "../asar.js";
import {
  disableEmbeddedAsarIntegrityValidation,
  isEmbeddedAsarIntegrityValidationDisabled,
} from "../fuses.js";
import {
  assertClaudePlusPlusRoamingPath,
  resolveClaudePlusPlusPaths,
  type ClaudePlusPlusPaths,
} from "../paths.js";
import { discoverClaudeInstall, type ClaudeInstall } from "../platform.js";
import {
  readClaudePlusPlusState,
  writeClaudePlusPlusState,
  writeJsonAtomic,
  type ClaudePlusPlusState,
} from "../state.js";
import {
  cleanupOldWindowsStoreMirrors,
  ensureWindowsStoreMirror,
} from "../windows-store-mirror.js";

const version = "0.2.7";
const defaultUpdateRepo = "kpkhxlgy0/claude-plusplus";
const execFileAsync = promisify(execFile);

export interface InstallCommandOptions {
  paths?: ClaudePlusPlusPaths;
  sourceRoot?: string;
  force?: boolean;
  cleanupAllOld?: boolean;
  watcher?: boolean;
}

export interface InstallCommandDeps {
  discover(): Promise<ClaudeInstall>;
  createShortcut(target: string, shortcut: string): Promise<void>;
  now(): Date;
}

export interface InstallCommandResult {
  status: "installed" | "current";
  state: ClaudePlusPlusState;
}

export async function installClaudePlusPlus(
  options: InstallCommandOptions = {},
  dependencies: Partial<InstallCommandDeps> = {},
): Promise<InstallCommandResult> {
  const paths = options.paths ?? resolveClaudePlusPlusPaths();
  const sourceRoot = options.sourceRoot ?? resolveInstallerSourceRoot();
  const discover = dependencies.discover ?? discoverClaudeInstall;
  const createShortcut = dependencies.createShortcut ?? createWindowsShortcut;
  const now = dependencies.now ?? (() => new Date());
  const migratedConfig = readMigratedRuntimeConfig(paths.configFile);
  const official = await discover();
  const mirror = await ensureWindowsStoreMirror(official, paths);
  const existingState = readClaudePlusPlusState(paths.stateFile);
  const existingLoader = inspectClaudePlusPlusLoader(mirror.asarPath);
  const isCurrent =
    !options.force &&
    mirror.reused &&
    existingState?.packageFullName === official.packageFullName &&
    existingState.packageVersion === official.packageVersion &&
    existingLoader?.metadata.loaderVersion === version &&
    isEmbeddedAsarIntegrityValidationDisabled(mirror.executablePath) &&
    existsSync(join(paths.runtime, "main.js")) &&
    existsSync(join(paths.runtime, "preload", "index.js"));

  if (isCurrent && existingState) {
    if (options.watcher) return { status: "current", state: existingState };
    await copyRuntimeAtomically(
      join(sourceRoot, "packages", "runtime", "dist"),
      paths,
    );
    if (!existsSync(paths.shortcutFile)) {
      await createShortcut(existingState.managedExecutable, paths.shortcutFile);
    }
    if (options.cleanupAllOld) {
      await cleanupOldWindowsStoreMirrors(paths, official.packageFullName);
    }
    writeJsonAtomic(paths.configFile, migratedConfig);
    return { status: "current", state: existingState };
  }

  await copyRuntimeAtomically(
    join(sourceRoot, "packages", "runtime", "dist"),
    paths,
  );
  disableEmbeddedAsarIntegrityValidation(mirror.executablePath);
  const inspection = await injectClaudePlusPlusLoader({
    managedAppRoot: mirror.appRoot,
    asarPath: mirror.asarPath,
    loaderPath: join(sourceRoot, "packages", "loader", "loader.cjs"),
    userRoot: paths.roamingRoot,
    loaderVersion: version,
  }, paths);
  const state: ClaudePlusPlusState = {
    schemaVersion: 1,
    claudePlusPlusVersion: version,
    packageFullName: official.packageFullName,
    packageVersion: official.packageVersion,
    officialAppRoot: official.appRoot,
    managedAppRoot: mirror.appRoot,
    managedExecutable: mirror.executablePath,
    asarPath: mirror.asarPath,
    originalMain: inspection.originalMain,
    installedAt: now().toISOString(),
    watcher: existingState?.watcher ?? "none",
  };
  writeClaudePlusPlusState(paths.stateFile, state);
  await createShortcut(state.managedExecutable, paths.shortcutFile);
  if (options.cleanupAllOld) {
    await cleanupOldWindowsStoreMirrors(paths, official.packageFullName);
  }
  writeJsonAtomic(paths.configFile, migratedConfig);
  return { status: "installed", state };
}

function readMigratedRuntimeConfig(path: string): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("root must be an object");
      input = parsed;
    } catch (error) {
      throw new Error(`Existing Claude++ config is invalid: ${errorMessage(error)}`);
    }
  }
  const current = isRecord(input.claudePlusPlus) ? input.claudePlusPlus : {};
  const updateChannel = current.updateChannel === "prerelease" || current.updateChannel === "custom"
    ? current.updateChannel
    : "stable";
  return {
    ...input,
    claudePlusPlus: {
      ...current,
      safeMode: current.safeMode === true,
      autoUpdate: current.autoUpdate === true,
      updateChannel,
      updateRepo: typeof current.updateRepo === "string" && current.updateRepo.trim()
        ? current.updateRepo
        : defaultUpdateRepo,
      updateRef: typeof current.updateRef === "string" ? current.updateRef : "",
    },
    tweaks: isRecord(input.tweaks) ? input.tweaks : {},
    tweakUpdateChecks: isRecord(input.tweakUpdateChecks) ? input.tweakUpdateChecks : {},
  };
}

async function copyRuntimeAtomically(source: string, paths: ClaudePlusPlusPaths): Promise<void> {
  if (!await pathExists(join(source, "main.js"))) {
    throw new Error(`Built Claude++ Runtime is missing: ${join(source, "main.js")}`);
  }
  if (!await pathExists(join(source, "preload", "index.js"))) {
    throw new Error(`Built Claude++ Renderer preload is missing: ${join(source, "preload", "index.js")}`);
  }

  const target = paths.runtime;
  const staging = `${target}.staging-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  for (const path of [target, staging, backup]) assertClaudePlusPlusRoamingPath(path, paths);
  let oldTargetMoved = false;
  await mkdir(dirname(target), { recursive: true });
  try {
    await cp(source, staging, { recursive: true, force: true });
    if (await pathExists(target)) {
      await rename(target, backup);
      oldTargetMoved = true;
    }
    await rename(staging, target);
    if (!await pathExists(join(target, "main.js"))) throw new Error("Copied Runtime main.js is missing");
    if (oldTargetMoved) await guardedRemove(backup, paths);
  } catch (error) {
    if (oldTargetMoved && await pathExists(backup)) {
      if (await pathExists(target)) await guardedRemove(target, paths);
      await rename(backup, target);
    }
    throw error;
  } finally {
    if (await pathExists(staging)) await guardedRemove(staging, paths);
  }
}

async function createWindowsShortcut(target: string, shortcut: string): Promise<void> {
  await mkdir(dirname(shortcut), { recursive: true });
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:CLAUDE_PLUSPLUS_SHORTCUT_FILE)",
    "$shortcut.TargetPath = $env:CLAUDE_PLUSPLUS_SHORTCUT_TARGET",
    "$shortcut.WorkingDirectory = Split-Path -Parent $env:CLAUDE_PLUSPLUS_SHORTCUT_TARGET",
    "$shortcut.IconLocation = $env:CLAUDE_PLUSPLUS_SHORTCUT_TARGET",
    "$shortcut.Save()",
  ].join("; ");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PLUSPLUS_SHORTCUT_FILE: shortcut,
        CLAUDE_PLUSPLUS_SHORTCUT_TARGET: target,
      },
    },
  );
}

export function resolveInstallerSourceRoot(metaUrl = import.meta.url): string {
  return dirname(fileURLToPath(new URL("../../../../package.json", metaUrl)));
}

async function guardedRemove(path: string, paths: ClaudePlusPlusPaths): Promise<void> {
  assertClaudePlusPlusRoamingPath(path, paths);
  await rm(path, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
