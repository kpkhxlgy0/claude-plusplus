import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";

export function getDebugInfo(paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths()) {
  return {
    roamingRoot: paths.roamingRoot,
    localRoot: paths.localRoot,
    sourceRoot: paths.sourceRoot,
    runtime: paths.runtime,
    tweaks: paths.tweaks,
    tweakData: paths.tweakData,
    logs: paths.logs,
    stateFile: paths.stateFile,
    configFile: paths.configFile,
    storeApps: paths.storeApps,
    shortcutFile: paths.shortcutFile,
  };
}
