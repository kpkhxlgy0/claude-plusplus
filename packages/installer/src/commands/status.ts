import { existsSync, readFileSync } from "node:fs";
import { inspectClaudePlusPlusLoader, readAsarHeaderHash } from "../asar.js";
import { isEmbeddedAsarIntegrityValidationDisabled } from "../fuses.js";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import {
  isClaudePlusPlusStateV2,
  readClaudePlusPlusState,
  type ClaudePlusPlusState,
} from "../state.js";

export type AsarProvenance = "patched" | "original" | "drift" | "unreadable" | "legacy";

export interface ClaudePlusPlusStatus {
  installed: boolean;
  version: string | null;
  packageVersion: string | null;
  managedExecutable: string | null;
  runtimeReady: boolean;
  loaderReady: boolean;
  integrityFuseReady: boolean;
  asarProvenance: AsarProvenance | null;
  safeMode: boolean;
}

export function classifyAsarProvenance(
  state: ClaudePlusPlusState | null,
  currentHash: string | null,
): AsarProvenance | null {
  if (!state) return null;
  if (!isClaudePlusPlusStateV2(state)) return "legacy";
  if (currentHash === null) return "unreadable";
  if (currentHash === state.patchedAsarHash) return "patched";
  if (currentHash === state.originalAsarHash) return "original";
  return "drift";
}

export function getClaudePlusPlusStatus(
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
): ClaudePlusPlusStatus {
  const state = readClaudePlusPlusState(paths.stateFile);
  const runtimeReady = existsSync(`${paths.runtime}\\main.js`) &&
    existsSync(`${paths.runtime}\\preload\\index.js`);
  const loaderReady = state ? inspectClaudePlusPlusLoader(state.asarPath) !== null : false;
  const integrityFuseReady = state ? readIntegrityFuse(state.managedExecutable) : false;
  const currentAsarHash = state?.schemaVersion === 2 ? readAsarHash(state.asarPath) : null;
  const asarProvenance = classifyAsarProvenance(state, currentAsarHash);
  const provenanceReady = state?.schemaVersion === 1 || asarProvenance === "patched";
  return {
    installed: Boolean(
      state && provenanceReady && existsSync(state.managedExecutable) &&
      runtimeReady && loaderReady && integrityFuseReady,
    ),
    version: state?.claudePlusPlusVersion ?? null,
    packageVersion: state?.packageVersion ?? null,
    managedExecutable: state?.managedExecutable ?? null,
    runtimeReady,
    loaderReady,
    integrityFuseReady,
    asarProvenance,
    safeMode: readSafeMode(paths.configFile),
  };
}

function readAsarHash(path: string): string | null {
  try {
    return readAsarHeaderHash(path);
  } catch {
    return null;
  }
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
