import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertClaudePlusPlusRoamingPath,
  resolveClaudePlusPlusPaths,
  type ClaudePlusPlusPaths,
} from "./paths.js";

export type WatcherKind = "scheduled-task" | "none";

export const WATCHER_TASK_NAMES = [
  "claude-plusplus-watcher",
  "claude-plusplus-watcher-interval",
  "claude-plusplus-watcher-hourly",
  "claude-plusplus-watcher-daily",
] as const;

export interface WatcherOptions {
  paths?: ClaudePlusPlusPaths;
  launcher?: string;
}

export type WatcherTaskRunner = (file: string, args: string[]) => void;
export type WatcherTaskRemover = (name: string) => void;

export function installWatcher(
  options: WatcherOptions = {},
  run: WatcherTaskRunner = runTaskScheduler,
): WatcherKind {
  const paths = options.paths ?? resolveClaudePlusPlusPaths();
  const launcher = options.launcher ?? join(paths.sourceRoot, "bin", "claudeplusplus.cmd");
  if (!existsSync(launcher)) throw new Error(`Claude++ installed launcher is missing: ${launcher}`);
  const script = writeWatcherScript(paths, launcher);
  const taskCommand = quoteTaskCommand(script);

  try {
    for (const name of WATCHER_TASK_NAMES) removeScheduledTaskWithRunner(name, run);
    run("schtasks.exe", [
      "/Create", "/F", "/SC", "ONLOGON", "/TN", "claude-plusplus-watcher", "/TR", taskCommand,
    ]);
    run("schtasks.exe", [
      "/Create", "/F", "/SC", "MINUTE", "/MO", "5",
      "/TN", "claude-plusplus-watcher-interval", "/TR", taskCommand,
    ]);
    return "scheduled-task";
  } catch {
    for (const name of WATCHER_TASK_NAMES) removeScheduledTaskWithRunner(name, run);
    rmSync(script, { force: true });
    return "none";
  }
}

export function uninstallWatcher(
  options: WatcherOptions = {},
  removeTask: WatcherTaskRemover = removeScheduledTask,
): void {
  const paths = options.paths ?? resolveClaudePlusPlusPaths();
  for (const name of WATCHER_TASK_NAMES) removeTask(name);
  const script = watcherScriptPath(paths);
  assertClaudePlusPlusRoamingPath(script, paths);
  rmSync(script, { force: true });
}

export function watcherScriptPath(paths: ClaudePlusPlusPaths): string {
  return join(paths.roamingRoot, "bin", "watcher.cmd");
}

function writeWatcherScript(paths: ClaudePlusPlusPaths, launcher: string): string {
  const script = watcherScriptPath(paths);
  assertClaudePlusPlusRoamingPath(script, paths);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, [
    "@echo off",
    "set CLAUDE_PLUSPLUS_WATCHER=1",
    `call ${quoteBatchArgument(launcher)} update --watcher`,
    `call ${quoteBatchArgument(launcher)} repair`,
    "exit /b 0",
    "",
  ].join("\r\n"), "utf8");
  return script;
}

function quoteBatchArgument(value: string): string {
  return `"${value}"`;
}

function quoteTaskCommand(value: string): string {
  return `"${value}"`;
}

function runTaskScheduler(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: "ignore", windowsHide: true });
}

function removeScheduledTask(name: string): void {
  removeScheduledTaskWithRunner(name, runTaskScheduler);
}

function removeScheduledTaskWithRunner(name: string, run: WatcherTaskRunner): void {
  for (const taskName of [name, `\\${name}`]) {
    for (const args of [
      ["/End", "/TN", taskName],
      ["/Change", "/Disable", "/TN", taskName],
      ["/Delete", "/F", "/TN", taskName],
    ]) {
      try {
        run("schtasks.exe", args);
      } catch {}
    }
  }
}
