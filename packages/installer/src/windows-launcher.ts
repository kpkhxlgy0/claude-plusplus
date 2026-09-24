import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertClaudePlusPlusRoamingPath, type ClaudePlusPlusPaths } from "./paths.js";

export const WINDOWS_MANAGED_LAUNCHER = "launch-packaged-claude.ps1";

export function windowsManagedLaunchCommand(paths: ClaudePlusPlusPaths): { command: string; args: string[] } {
  return {
    command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
      "-File", join(paths.roamingRoot, "bin", WINDOWS_MANAGED_LAUNCHER)],
  };
}

export function installWindowsManagedLauncher(paths: ClaudePlusPlusPaths): string {
  const script = join(paths.roamingRoot, "bin", WINDOWS_MANAGED_LAUNCHER);
  assertClaudePlusPlusRoamingPath(script, paths);
  mkdirSync(join(paths.roamingRoot, "bin"), { recursive: true });
  writeFileSync(script, windowsManagedLauncherScript().replace(/\r?\n/g, "\r\n"), "utf8");
  return script;
}

function windowsManagedLauncherScript(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
$launchArguments = @($args)
$claudeDataRoot = Split-Path -Parent $PSScriptRoot
try {
    $state = Get-Content -LiteralPath (Join-Path $claudeDataRoot 'state.json') -Raw | ConvertFrom-Json
    $mirrorRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'claude-plusplus\store-apps'))
    $packageFullName = [string]$state.packageFullName
    $appRoot = [IO.Path]::GetFullPath([string]$state.managedAppRoot)
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path (Join-Path $mirrorRoot $packageFullName) 'app'))
    if (-not $packageFullName -or $packageFullName -ne (Split-Path -Leaf (Split-Path -Parent $appRoot)) -or
        -not [string]::Equals($appRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Invalid Claude++ Store mirror. Run claudeplusplus repair.'
    }
    $executable = [IO.Path]::GetFullPath([string]$state.managedExecutable)
    if (-not [string]::Equals($executable, (Join-Path $appRoot 'claude.exe'),
        [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw 'The Claude++ executable is invalid or missing. Run claudeplusplus repair.'
    }
    $packages = @(Get-AppxPackage | Where-Object { $_.PackageFullName -eq $packageFullName })
    if ($packages.Count -ne 1) {
        throw 'The matching Claude package is no longer installed. Run claudeplusplus repair.'
    }
    $package = $packages[0]
    if (-not $package.PackageFamilyName) { throw 'The Claude package identity is invalid. Run claudeplusplus repair.' }
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $apps = @($manifest.Package.Applications.Application | Where-Object {
        ($_.Executable -replace '/', '\') -eq 'app\claude.exe'
    })
    if ($apps.Count -ne 1 -or -not $apps[0].Id) {
        throw 'Cannot identify the matching Claude application in the installed package. Run claudeplusplus repair.'
    }
    $quotedArguments = @($launchArguments | ForEach-Object {
        $value = [regex]::Replace([string]$_, '(\\*)"', '$1$1\"')
        '"' + [regex]::Replace($value, '(\\+)$', '$1$1') + '"'
    })
    $parameters = @{
        PackageFamilyName = $package.PackageFamilyName
        AppId = $apps[0].Id
        Command = $executable
    }
    if ($quotedArguments.Count -gt 0) { $parameters.Args = $quotedArguments -join ' ' }
    Invoke-CommandInDesktopPackage @parameters
} catch {
    $logDir = Join-Path $claudeDataRoot 'log'
    [void](New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue)
    Add-Content -LiteralPath (Join-Path $logDir 'packaged-launcher.log') -Encoding UTF8 -ErrorAction SilentlyContinue -Value ('[{0:o}] {1}' -f (Get-Date), $_)
    [Console]::Error.WriteLine($_.ToString())
    exit 1
}
`;
}
