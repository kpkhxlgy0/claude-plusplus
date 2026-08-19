#!/usr/bin/env node

import { getDebugInfo } from "./commands/debug.js";
import { doctorClaudePlusPlus } from "./commands/doctor.js";
import { installClaudePlusPlus } from "./commands/install.js";
import { launchClaudePlusPlus } from "./commands/launch.js";
import { repairClaudePlusPlus } from "./commands/repair.js";
import { setSafeMode } from "./commands/safe-mode.js";
import { getClaudePlusPlusStatus } from "./commands/status.js";
import { uninstallClaudePlusPlus } from "./commands/uninstall.js";
import { parseSelfUpdateArguments, selfUpdate } from "./commands/self-update.js";
import { runWatcherCommand } from "./commands/watcher.js";

const version = "0.2.7";

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(version);
    return;
  }

  switch (command) {
    case "install":
      print(await installClaudePlusPlus({ cleanupAllOld: argv.includes("--cleanup-all-old") }));
      return;
    case "status":
      print(getClaudePlusPlusStatus());
      return;
    case "debug":
      print(getDebugInfo());
      return;
    case "doctor":
      print(await doctorClaudePlusPlus());
      return;
    case "repair":
      print(await repairClaudePlusPlus({ watcher: process.env.CLAUDE_PLUSPLUS_WATCHER === "1" }));
      return;
    case "update":
    case "self-update":
      print(await selfUpdate(parseSelfUpdateArguments(argv.slice(1))));
      return;
    case "watcher":
      print(await runWatcherCommand(argv[1]));
      return;
    case "safe-mode":
      setSafeMode(undefined, !argv.includes("--off"));
      print({ safeMode: !argv.includes("--off") });
      return;
    case "launch":
      launchClaudePlusPlus();
      print({ launched: true });
      return;
    case "uninstall":
      await uninstallClaudePlusPlus({ purge: argv.includes("--purge") });
      print({ uninstalled: true, purged: argv.includes("--purge") });
      return;
    default:
      throw new Error(`Unknown Claude++ command: ${command}`);
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Claude++ ${version}

Usage: claudeplusplus <command>

Commands:
  install [--cleanup-all-old]
                       Install or maintain the managed Claude app; optionally remove all non-current mirrors
  status               Show installation status
  debug                Show exact local Claude++ paths
  doctor               Run non-destructive diagnostics
  repair               Rebuild the managed app and Runtime
  update [--prerelease] [--repo owner/repo --ref ref] [--watcher] [--force]
                       Install a verified release or explicitly trusted Custom source
  self-update [...]    Alias for update
  watcher enable|disable|status
                       Manage the optional logon and five-minute repair tasks
  safe-mode [--off]    Enable or disable Safe Mode
  launch               Launch the managed Claude app
  uninstall [--purge]  Remove Claude++; preserve Tweak data unless purged
`);
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
