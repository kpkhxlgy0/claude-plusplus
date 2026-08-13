export interface ClaudePlusPlusPaths {
  roamingRoot: string;
  localRoot: string;
  sourceRoot: string;
  runtime: string;
  tweaks: string;
  tweakData: string;
  logs: string;
  stateFile: string;
  selfUpdateStateFile: string;
  configFile: string;
  storeApps: string;
  cache: string;
  toolchain: string;
  shortcutFile: string;
}

export function resolveClaudePlusPlusPaths(_env: NodeJS.ProcessEnv = process.env): ClaudePlusPlusPaths {
  const appData = requireEnvironmentPath(_env, "APPDATA");
  const localAppData = requireEnvironmentPath(_env, "LOCALAPPDATA");
  const userProfile = requireEnvironmentPath(_env, "USERPROFILE");
  const roamingRoot = win32.join(appData, "claude-plusplus");
  const localRoot = win32.join(localAppData, "claude-plusplus");

  return {
    roamingRoot,
    localRoot,
    sourceRoot: win32.join(userProfile, ".claude-plusplus", "source"),
    runtime: win32.join(roamingRoot, "runtime"),
    tweaks: win32.join(roamingRoot, "tweaks"),
    tweakData: win32.join(roamingRoot, "tweak-data"),
    logs: win32.join(roamingRoot, "log"),
    stateFile: win32.join(roamingRoot, "state.json"),
    selfUpdateStateFile: win32.join(roamingRoot, "self-update.json"),
    configFile: win32.join(roamingRoot, "config.json"),
    storeApps: win32.join(localRoot, "store-apps"),
    cache: win32.join(localRoot, "cache"),
    toolchain: win32.join(localRoot, "toolchain"),
    shortcutFile: win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Claude++.lnk"),
  };
}

export function assertClaudePlusPlusRoamingPath(
  candidate: string,
  paths: ClaudePlusPlusPaths,
  allowRoot = false,
): void {
  const root = win32.resolve(paths.roamingRoot);
  const target = win32.resolve(candidate);
  const child = win32.relative(root, target);
  if ((!allowRoot && !child) || child.startsWith("..") || win32.isAbsolute(child)) {
    throw new Error(`Path is outside the Claude++ roaming root: ${candidate}`);
  }
}

function requireEnvironmentPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required on Windows`);
  return value;
}
import { win32 } from "node:path";
