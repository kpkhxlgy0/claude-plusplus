import {
  uninstallClaudePlusPlus,
  type UninstallOptions,
  type UninstallResult,
} from "./commands/uninstall.js";

export interface RecoveryCliDependencies {
  io: {
    stdout(line: string): void;
    stderr(line: string): void;
  };
  uninstall(options: UninstallOptions): Promise<UninstallResult>;
}

export async function runRecoveryCli(
  command: string,
  args: string[],
  dependencies: Partial<RecoveryCliDependencies> = {},
): Promise<boolean> {
  if (command !== "uninstall") return false;

  const io = dependencies.io ?? {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
  const purge = args.includes("--purge");
  const uninstall = dependencies.uninstall ?? uninstallClaudePlusPlus;
  const result = await uninstall({ purge });
  for (const warning of result.warnings) io.stderr(`warning: ${warning}`);
  io.stdout(JSON.stringify({ uninstalled: true, purged: purge, warnings: result.warnings }, null, 2));
  return true;
}
