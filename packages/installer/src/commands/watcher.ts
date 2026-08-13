import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import {
  readClaudePlusPlusState,
  writeClaudePlusPlusState,
} from "../state.js";
import { inspectWatcher, type WatcherInspection } from "../watcher-health.js";
import { installWatcher, uninstallWatcher, type WatcherKind } from "../watcher.js";

export interface WatcherCommandDependencies {
  install(): WatcherKind;
  uninstall(): void;
  inspect(): WatcherInspection;
}

export async function runWatcherCommand(
  action: string | undefined,
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  dependencies: Partial<WatcherCommandDependencies> = {},
): Promise<WatcherInspection> {
  if (action !== "enable" && action !== "disable" && action !== "status") {
    throw new Error("Usage: claudeplusplus watcher enable|disable|status");
  }
  const deps: WatcherCommandDependencies = {
    install: dependencies.install ?? (() => installWatcher({ paths })),
    uninstall: dependencies.uninstall ?? (() => uninstallWatcher({ paths })),
    inspect: dependencies.inspect ?? (() => inspectWatcher({ paths })),
  };
  if (action === "status") return deps.inspect();

  const state = readClaudePlusPlusState(paths.stateFile);
  if (action === "enable") {
    if (!state) throw new Error("Claude++ must be installed before enabling the Watcher");
    const watcher = deps.install();
    if (watcher !== "scheduled-task") throw new Error("Claude++ Watcher task creation failed");
    writeClaudePlusPlusState(paths.stateFile, { ...state, watcher });
    return { installed: true, watcher, tasks: [], scriptExists: true };
  }

  deps.uninstall();
  if (state) writeClaudePlusPlusState(paths.stateFile, { ...state, watcher: "none" });
  return { installed: false, watcher: "none", tasks: [], scriptExists: false };
}
