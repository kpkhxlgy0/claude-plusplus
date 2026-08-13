import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  resolveClaudePlusPlusPaths,
  type ClaudePlusPlusPaths,
} from "./paths.js";
import { readClaudePlusPlusState } from "./state.js";
import { watcherScriptPath, WATCHER_TASK_NAMES, type WatcherKind } from "./watcher.js";

export interface WatcherInspection {
  installed: boolean;
  watcher: WatcherKind;
  tasks: string[];
  scriptExists: boolean;
}

export interface InspectWatcherOptions {
  paths?: ClaudePlusPlusPaths;
}

export function inspectWatcher(
  options: InspectWatcherOptions = {},
  queryTask: (name: string) => boolean = queryScheduledTask,
): WatcherInspection {
  const paths = options.paths ?? resolveClaudePlusPlusPaths();
  const state = readClaudePlusPlusState(paths.stateFile);
  const tasks = WATCHER_TASK_NAMES.filter((name) => queryTask(name));
  const scriptExists = existsSync(watcherScriptPath(paths));
  const installed = state?.watcher === "scheduled-task" && scriptExists &&
    tasks.includes("claude-plusplus-watcher") &&
    tasks.includes("claude-plusplus-watcher-interval");
  return {
    installed,
    watcher: installed ? "scheduled-task" : "none",
    tasks,
    scriptExists,
  };
}

function queryScheduledTask(name: string): boolean {
  try {
    execFileSync("schtasks.exe", ["/Query", "/TN", name], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
