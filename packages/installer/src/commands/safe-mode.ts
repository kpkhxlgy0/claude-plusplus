import { readFileSync } from "node:fs";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import { writeJsonAtomic } from "../state.js";

interface ClaudePlusPlusConfig {
  claudePlusPlus?: { safeMode?: boolean };
  [key: string]: unknown;
}

export function setSafeMode(
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  enabled = true,
): void {
  const config = readConfig(paths.configFile);
  config.claudePlusPlus = { ...config.claudePlusPlus, safeMode: enabled };
  writeJsonAtomic(paths.configFile, config);
}

function readConfig(path: string): ClaudePlusPlusConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaudePlusPlusConfig;
  } catch {
    return {};
  }
}
