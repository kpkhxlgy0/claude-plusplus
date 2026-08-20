import {
  parseSafeModeArguments,
  runSafeMode,
  type SafeModeAction,
  type SafeModeResult,
} from "./commands/safe-mode.js";
import {
  uninstallClaudePlusPlus,
  type UninstallOptions,
  type UninstallResult,
} from "./commands/uninstall.js";

export const RECOVERY_HELP_TEXT = `  safe-mode [--on|--off|--status]
                       Enable, disable, or inspect Safe Mode; active Main Tweaks reload immediately
                       Restart Claude to fully apply Renderer preload and CSP state
  uninstall [--purge]  Remove Claude++; preserve Tweak data unless purged`;

export interface RecoveryCliDependencies {
  io: {
    stdout(line: string): void;
    stderr(line: string): void;
  };
  safeMode(action: SafeModeAction): SafeModeResult;
  uninstall(options: UninstallOptions): Promise<UninstallResult>;
}

export async function runRecoveryCli(
  command: string,
  args: string[],
  dependencies: Partial<RecoveryCliDependencies> = {},
): Promise<boolean> {
  if (command !== "uninstall" && command !== "safe-mode") return false;

  const io = dependencies.io ?? {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
  if (command === "safe-mode") {
    const action = parseSafeModeArguments(args);
    const safeMode = dependencies.safeMode ?? runSafeMode;
    io.stdout(JSON.stringify(safeMode(action), null, 2));
    return true;
  }

  const purge = args.includes("--purge");
  const uninstall = dependencies.uninstall ?? uninstallClaudePlusPlus;
  const result = await uninstall({ purge });
  for (const warning of result.warnings) io.stderr(`warning: ${warning}`);
  io.stdout(JSON.stringify({ uninstalled: true, purged: purge, warnings: result.warnings }, null, 2));
  return true;
}
