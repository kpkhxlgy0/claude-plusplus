import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import { writeJsonAtomic } from "../state.js";

interface ClaudePlusPlusConfig {
  claudePlusPlus?: { safeMode?: boolean };
  [key: string]: unknown;
}

export type SafeModeAction = "on" | "off" | "status";

export interface SafeModeDependencies {
  now(): number;
}

export interface SafeModeResult {
  safeMode: boolean;
  changed: boolean;
  restartRequired: boolean;
}

export function parseSafeModeArguments(argv: string[]): SafeModeAction {
  const seen = new Set<SafeModeAction>();
  for (const argument of argv) {
    let action: SafeModeAction;
    switch (argument) {
      case "--on":
        action = "on";
        break;
      case "--off":
        action = "off";
        break;
      case "--status":
        action = "status";
        break;
      default:
        throw new Error(`Unknown Safe Mode argument: ${argument}`);
    }
    if (seen.has(action)) throw new Error(`Duplicate Safe Mode action: ${argument}`);
    if (seen.size > 0) throw new Error("Choose only one of --on, --off, or --status");
    seen.add(action);
  }
  return seen.values().next().value ?? "on";
}

export function runSafeMode(
  action: SafeModeAction = "on",
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  dependencies: Partial<SafeModeDependencies> = {},
): SafeModeResult {
  const config = readConfig(paths.configFile);
  const current = config.claudePlusPlus?.safeMode === true;
  if (action === "status") {
    return { safeMode: current, changed: false, restartRequired: false };
  }
  const enabled = action === "on";
  config.claudePlusPlus = { ...config.claudePlusPlus, safeMode: enabled };
  writeJsonAtomic(paths.configFile, config);
  mkdirSync(paths.tweaks, { recursive: true });
  writeFileSync(
    join(paths.tweaks, ".claudepp-safe-mode-reload"),
    String((dependencies.now ?? Date.now)()),
    "utf8",
  );
  return { safeMode: enabled, changed: current !== enabled, restartRequired: true };
}

function readConfig(path: string): ClaudePlusPlusConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaudePlusPlusConfig;
  } catch {
    return {};
  }
}
