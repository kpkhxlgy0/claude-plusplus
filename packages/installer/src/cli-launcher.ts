import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertClaudePlusPlusRoamingPath, type ClaudePlusPlusPaths } from "./paths.js";

export function cliLauncherPath(paths: ClaudePlusPlusPaths): string {
  return join(paths.roamingRoot, "bin", "claudeplusplus.cmd");
}

export function installCliLauncher(
  paths: ClaudePlusPlusPaths,
  sourceRoot: string,
  nodeRuntimePath: string,
): string {
  const launcher = cliLauncherPath(paths);
  assertClaudePlusPlusRoamingPath(launcher, paths);
  const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
  const command = `${quoteBatchPath(nodeRuntimePath)} ${quoteBatchPath(cli)} %*`;
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "_claudeppCodePage="',
    'for /f "tokens=2 delims=:" %%c in (\'chcp\') do set "_claudeppCodePage=%%c"',
    "chcp 65001 >nul",
    command,
    'set "_claudeppExitCode=%errorlevel%"',
    "if defined _claudeppCodePage chcp %_claudeppCodePage% >nul",
    "exit /b %_claudeppExitCode%",
    "",
  ].join("\r\n"), "utf8");
  return launcher;
}

function quoteBatchPath(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error("Claude++ CLI binding contains an invalid path");
  return `"${value.replaceAll("%", "%%")}"`;
}
