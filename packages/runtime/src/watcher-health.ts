import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WatcherHealthStatus = "ok" | "warn" | "error";

export interface WatcherHealthCheck {
  name: string;
  status: WatcherHealthStatus;
  detail: string;
}

export interface WatcherHealth {
  checkedAt: string;
  status: WatcherHealthStatus;
  title: string;
  summary: string;
  watcher: "scheduled-task" | "none";
  installed: boolean;
  autoUpdate: boolean;
  autoUpdateAvailable: boolean;
  checks: WatcherHealthCheck[];
}

export interface WatcherHealthInput {
  watcher: "scheduled-task" | "none";
  autoUpdate: boolean;
  tasks: string[];
  scriptExists?: boolean;
  now?: () => Date;
}

export function buildWatcherHealth(input: WatcherHealthInput): WatcherHealth {
  const logonReady = input.tasks.includes("claude-plusplus-watcher");
  const intervalReady = input.tasks.includes("claude-plusplus-watcher-interval");
  const scriptReady = input.scriptExists === true;
  const installed = input.watcher === "scheduled-task" && logonReady && intervalReady && scriptReady;
  const checks: WatcherHealthCheck[] = [
    {
      name: "Logon task",
      status: logonReady ? "ok" : input.watcher === "none" ? "warn" : "error",
      detail: "claude-plusplus-watcher",
    },
    {
      name: "Five-minute task",
      status: intervalReady ? "ok" : input.watcher === "none" ? "warn" : "error",
      detail: "claude-plusplus-watcher-interval",
    },
    {
      name: "Watcher command",
      status: scriptReady ? "ok" : input.watcher === "none" ? "warn" : "error",
      detail: "watcher.cmd",
    },
  ];
  if (installed) {
    checks.push({
      name: "Automatic refresh",
      status: input.autoUpdate ? "ok" : "warn",
      detail: input.autoUpdate ? "enabled" : "disabled in Claude++ Config",
    });
  }
  const status: WatcherHealthStatus = !installed
    ? input.watcher === "none" ? "warn" : "error"
    : input.autoUpdate ? "ok" : "warn";
  return {
    checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    status,
    title: installed ? "Auto-repair Watcher is ready" : "Auto-repair Watcher is not installed",
    summary: installed
      ? input.autoUpdate
        ? "Runs at logon and every five minutes; automatic refresh is enabled."
        : "Runs at logon and every five minutes; automatic refresh is disabled."
      : "Watcher is not installed. Enable it before automatic refresh can be used.",
    watcher: installed ? "scheduled-task" : "none",
    installed,
    autoUpdate: input.autoUpdate,
    autoUpdateAvailable: installed,
    checks,
  };
}

export function getWatcherHealth(
  userRoot: string,
  queryTask: (name: string) => boolean = queryScheduledTask,
): WatcherHealth {
  const state = readJson<{ watcher?: "scheduled-task" | "none" }>(join(userRoot, "state.json"));
  const config = readJson<{ claudePlusPlus?: { autoUpdate?: boolean } }>(join(userRoot, "config.json"));
  const tasks = ["claude-plusplus-watcher", "claude-plusplus-watcher-interval"].filter(queryTask);
  return buildWatcherHealth({
    watcher: state?.watcher === "scheduled-task" ? "scheduled-task" : "none",
    autoUpdate: config?.claudePlusPlus?.autoUpdate === true,
    tasks,
    scriptExists: existsSync(join(userRoot, "bin", "watcher.cmd")),
  });
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

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
