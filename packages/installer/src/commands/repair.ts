import {
  installClaudePlusPlus,
  type InstallCommandDeps,
  type InstallCommandOptions,
  type InstallCommandResult,
} from "./install.js";

export function repairClaudePlusPlus(
  options: InstallCommandOptions = {},
  dependencies: Partial<InstallCommandDeps> = {},
): Promise<InstallCommandResult> {
  return installClaudePlusPlus({ ...options, force: !options.watcher }, dependencies);
}
