import { spawn } from "node:child_process";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import { readClaudePlusPlusState } from "../state.js";

export interface DetachedProcess {
  unref(): void;
}

export type LaunchProcess = (executable: string) => DetachedProcess;

export function launchClaudePlusPlus(
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  launch: LaunchProcess = defaultLaunch,
): void {
  const state = readClaudePlusPlusState(paths.stateFile);
  if (!state) throw new Error("Claude++ is not installed");
  launch(state.managedExecutable).unref();
}

function defaultLaunch(executable: string): DetachedProcess {
  return spawn(executable, [], { detached: true, stdio: "ignore" });
}
