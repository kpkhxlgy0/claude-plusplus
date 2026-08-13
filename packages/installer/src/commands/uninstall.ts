import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import {
  assertClaudePlusPlusRoamingPath,
  resolveClaudePlusPlusPaths,
  type ClaudePlusPlusPaths,
} from "../paths.js";
import { readClaudePlusPlusState } from "../state.js";
import { assertManagedMirrorPath } from "../windows-store-mirror.js";
import { uninstallWatcher } from "../watcher.js";

export interface UninstallOptions {
  paths?: ClaudePlusPlusPaths;
  purge?: boolean;
}

export interface UninstallDependencies {
  uninstallWatcher(paths: ClaudePlusPlusPaths): void;
}

export async function uninstallClaudePlusPlus(
  options: UninstallOptions = {},
  dependencies: Partial<UninstallDependencies> = {},
): Promise<void> {
  const paths = options.paths ?? resolveClaudePlusPlusPaths();
  const cleanupWatcher = dependencies.uninstallWatcher ?? ((value) => uninstallWatcher({ paths: value }));
  const state = readClaudePlusPlusState(paths.stateFile);
  const managedPackageRoot = state ? dirname(state.managedAppRoot) : null;

  if (managedPackageRoot) assertManagedMirrorPath(managedPackageRoot, paths);
  assertClaudePlusPlusRoamingPath(paths.runtime, paths);
  if (options.purge) assertClaudePlusPlusRoamingPath(paths.roamingRoot, paths, true);

  cleanupWatcher(paths);
  if (managedPackageRoot) await rm(managedPackageRoot, { recursive: true, force: true });
  await rm(paths.runtime, { recursive: true, force: true });
  await rm(paths.stateFile, { force: true });
  await rm(paths.shortcutFile, { force: true });
  if (options.purge) await rm(paths.roamingRoot, { recursive: true, force: true });
}
