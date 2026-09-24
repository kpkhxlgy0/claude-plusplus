import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import { readClaudePlusPlusState } from "../state.js";
import { windowsManagedLaunchCommand } from "../windows-launcher.js";

export interface DetachedProcess {
  unref(): void;
}

export type LaunchProcess = (executable: string, args: string[]) => DetachedProcess;

export function launchClaudePlusPlus(
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  launch: LaunchProcess = defaultLaunch,
  launchArguments: string[] = [],
): void {
  const state = readClaudePlusPlusState(paths.stateFile);
  if (!state) throw new Error("Claude++ is not installed");
  const command = windowsManagedLaunchCommand(paths);
  if (!existsSync(command.args.at(-1)!)) {
    throw new Error("Claude++ packaged launcher is missing. Run claudeplusplus repair.");
  }
  launch(command.command, [...command.args, ...launchArguments]).unref();
}

function defaultLaunch(executable: string, args: string[]): DetachedProcess {
  return spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
}
