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

export function assertClaudePlusPlusLocalPath(
  candidate: string,
  paths: ClaudePlusPlusPaths,
  allowRoot = false,
): void {
  const root = win32.resolve(paths.localRoot);
  const target = win32.resolve(candidate);
  const child = win32.relative(root, target);
  if ((!allowRoot && !child) || child.startsWith("..") || win32.isAbsolute(child)) {
    throw new Error(`Path is outside the Claude++ local root: ${candidate}`);
  }
}

export function assertClaudePlusPlusStoreAppsPath(paths: ClaudePlusPlusPaths): void {
  const expected = win32.resolve(win32.join(paths.localRoot, "store-apps"));
  const actual = win32.resolve(paths.storeApps);
  assertExactWindowsPath(actual, expected, "Claude++ store-apps root", paths.storeApps);
  assertClaudePlusPlusLocalPath(paths.storeApps, paths);
}

export function assertClaudePlusPlusUninstallTargets(paths: ClaudePlusPlusPaths): void {
  assertExactWindowsPath(
    paths.runtime,
    win32.join(paths.roamingRoot, "runtime"),
    "Claude++ Runtime directory",
  );
  assertClaudePlusPlusRoamingPath(paths.runtime, paths);

  assertExactWindowsPath(
    paths.stateFile,
    win32.join(paths.roamingRoot, "state.json"),
    "Claude++ state file",
  );
  assertClaudePlusPlusRoamingPath(paths.stateFile, paths);

  assertExactWindowsPath(
    paths.shortcutFile,
    win32.join(
      win32.dirname(paths.roamingRoot),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Claude++.lnk",
    ),
    "Claude++ Start Menu shortcut",
  );

  assertClaudePlusPlusStoreAppsPath(paths);
}

function assertExactWindowsPath(
  actual: string,
  expected: string,
  targetName: string,
  rejectedTarget = actual,
): void {
  if (win32.resolve(actual).toLowerCase() !== win32.resolve(expected).toLowerCase()) {
    throw new Error(`Path is not the exact ${targetName}: ${rejectedTarget}`);
  }
}

function requireEnvironmentPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required on Windows`);
  return value;
}
import { win32 } from "node:path";
