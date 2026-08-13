import { existsSync, readFileSync } from "node:fs";
import { inspectClaudePlusPlusLoader } from "../asar.js";
import { isEmbeddedAsarIntegrityValidationDisabled } from "../fuses.js";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import { readClaudePlusPlusState } from "../state.js";

export interface ClaudePlusPlusStatus {
  installed: boolean;
  version: string | null;
  packageVersion: string | null;
  managedExecutable: string | null;
  runtimeReady: boolean;
  loaderReady: boolean;
  integrityFuseReady: boolean;
  safeMode: boolean;
}

export function getClaudePlusPlusStatus(
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
): ClaudePlusPlusStatus {
  const state = readClaudePlusPlusState(paths.stateFile);
  const runtimeReady = existsSync(`${paths.runtime}\\main.js`) &&
    existsSync(`${paths.runtime}\\preload\\index.js`);
  const loaderReady = state ? inspectClaudePlusPlusLoader(state.asarPath) !== null : false;
  const integrityFuseReady = state ? readIntegrityFuse(state.managedExecutable) : false;
  return {
    installed: Boolean(
      state && existsSync(state.managedExecutable) && runtimeReady && loaderReady && integrityFuseReady,
    ),
    version: state?.claudePlusPlusVersion ?? null,
    packageVersion: state?.packageVersion ?? null,
    managedExecutable: state?.managedExecutable ?? null,
    runtimeReady,
    loaderReady,
    integrityFuseReady,
    safeMode: readSafeMode(paths.configFile),
  };
}

function readIntegrityFuse(path: string): boolean {
  try {
    return isEmbeddedAsarIntegrityValidationDisabled(path);
  } catch {
    return false;
  }
}

function readSafeMode(path: string): boolean {
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      claudePlusPlus?: { safeMode?: boolean };
    };
    return config.claudePlusPlus?.safeMode === true;
  } catch {
    return false;
  }
}
