export interface ClaudeInstall {
  packageFullName: string;
  packageVersion: string;
  installLocation: string;
  appRoot: string;
  executablePath: string;
  resourcesPath: string;
  asarPath: string;
}

export interface ClaudeDiscoveryDeps {
  runPowerShell(script: string): Promise<string>;
  pathExists(path: string): boolean;
}

const execFileAsync = promisify(execFile);
const discoveryScript = [
  "Get-AppxPackage -Name Claude",
  "Sort-Object Version -Descending",
  "Select-Object -First 1 Name,Version,InstallLocation,PackageFullName",
  "ConvertTo-Json -Compress",
].join(" | ");

export function parseClaudeAppxPackageJson(
  raw: string,
  pathExists: (path: string) => boolean = existsSync,
): ClaudeInstall {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Claude Appx metadata is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error("Claude Appx metadata must be an object");

  const packageFullName = requireString(value, "PackageFullName");
  const packageVersion = requireString(value, "Version");
  const installLocation = requireString(value, "InstallLocation");
  const appRoot = win32.join(installLocation, "app");
  const executablePath = win32.join(appRoot, "claude.exe");
  const resourcesPath = win32.join(appRoot, "resources");
  const asarPath = win32.join(resourcesPath, "app.asar");

  if (!pathExists(executablePath)) throw new Error(`Claude executable is missing: ${executablePath}`);
  if (!pathExists(asarPath)) throw new Error(`Claude app.asar is missing: ${asarPath}`);

  return {
    packageFullName,
    packageVersion,
    installLocation,
    appRoot,
    executablePath,
    resourcesPath,
    asarPath,
  };
}

export async function discoverClaudeInstall(deps?: ClaudeDiscoveryDeps): Promise<ClaudeInstall> {
  const runPowerShell = deps?.runPowerShell ?? defaultRunPowerShell;
  const pathExists = deps?.pathExists ?? existsSync;
  const raw = await runPowerShell(discoveryScript);
  if (!raw.trim()) throw new Error("Get-AppxPackage did not return a Claude installation");
  return parseClaudeAppxPackageJson(raw, pathExists);
}

async function defaultRunPowerShell(script: string): Promise<string> {
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return result.stdout;
}

function requireString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Claude Appx metadata field ${name} is missing`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { win32 } from "node:path";
