import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";
import { installWindowsManagedLauncher, windowsManagedLaunchCommand } from "../src/windows-launcher.ts";

const windowsOnly = { skip: process.platform !== "win32" };
const packageName = "Claude_1.2.3.0_x64__publisher";
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claudepp-launcher-"));
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), USERPROFILE: join(root, "home"),
  });
  const appRoot = join(paths.storeApps, packageName, "app");
  const executable = join(appRoot, "claude.exe");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(executable, "fixture");
  mkdirSync(paths.roamingRoot, { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify({
    managedAppRoot: appRoot, managedExecutable: executable, packageFullName: packageName,
  }));
  return { root, paths, appRoot, executable };
}

function cleanup(root: string) {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
}

function run(script: string, localRoot: string, stubs = packageStubs(packageName), args: string[] = []) {
  return spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(`${stubs}\n& ${quote(script)} ${args.map(quote).join(" ")}; exit $LASTEXITCODE`, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, LOCALAPPDATA: localRoot } });
}

function packageStubs(fullName: string, manifest = '<Package><Applications><Application Id="ClaudeApp" Executable="app/claude.exe" /></Applications></Package>') {
  return `$ErrorActionPreference = 'Stop'
function Get-AppxPackage { [PSCustomObject]@{ PackageFullName=${quote(fullName)}; PackageFamilyName='Claude_publisher' } }
function Get-AppxPackageManifest { [xml]${quote(manifest)} }
function Invoke-CommandInDesktopPackage {
  param($PackageFamilyName, $AppId, $Command, $Args)
  $PSBoundParameters | ConvertTo-Json -Compress
}`;
}

test("launcher activates the exact package application and quotes every forwarded argument", windowsOnly, () => {
  const value = fixture();
  try {
    const launcher = installWindowsManagedLauncher(value.paths);
    const args = ["C:\\project with spaces\\", 'a"b', "$(throw 'evaluated')", ""];
    const result = run(launcher, value.paths.localRoot.replace(/\\claude-plusplus$/i, ""), packageStubs(packageName), args);
    assert.equal(result.status, 0, result.stderr);
    const { Command: executable, ...parameters } = JSON.parse(result.stdout);
    assert.equal(realpathSync.native(executable), realpathSync.native(value.executable));
    assert.deepEqual(parameters, {
      PackageFamilyName: "Claude_publisher", AppId: "ClaudeApp",
      Args: '"C:\\project with spaces\\\\" "a\\"b" "$(throw \'evaluated\')" ""',
    });
    assert.equal(windowsManagedLaunchCommand(value.paths).args.at(-1), launcher);
  } finally {
    cleanup(value.root);
  }
});

test("launcher follows repaired state and rejects a stale installed package", windowsOnly, () => {
  const value = fixture();
  try {
    const launcher = installWindowsManagedLauncher(value.paths);
    const local = value.paths.localRoot.replace(/\\claude-plusplus$/i, "");
    const stale = run(launcher, local, packageStubs("Claude_9.0.0.0_x64__publisher"));
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /repair/i);
    assert.ok(existsSync(join(value.paths.logs, "packaged-launcher.log")));

    const nextName = "Claude_9.0.0.0_x64__publisher";
    const nextRoot = join(value.paths.storeApps, nextName, "app");
    mkdirSync(nextRoot, { recursive: true });
    writeFileSync(join(nextRoot, "claude.exe"), "next");
    writeFileSync(value.paths.stateFile, JSON.stringify({ managedAppRoot: nextRoot,
      managedExecutable: join(nextRoot, "claude.exe"), packageFullName: nextName }));
    const updated = run(launcher, local, packageStubs(nextName));
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(realpathSync.native(JSON.parse(updated.stdout).Command),
      realpathSync.native(join(nextRoot, "claude.exe")));
  } finally {
    cleanup(value.root);
  }
});

test("launcher rejects forged paths, package names, and ambiguous manifests", windowsOnly, () => {
  const value = fixture();
  try {
    const launcher = installWindowsManagedLauncher(value.paths);
    const local = value.paths.localRoot.replace(/\\claude-plusplus$/i, "");
    const original = JSON.parse(readFileSync(value.paths.stateFile, "utf8"));
    const ambiguous = packageStubs(packageName,
      '<Package><Applications><Application Id="One" Executable="app/claude.exe" />' +
      '<Application Id="Two" Executable="app/claude.exe" /></Applications></Package>');
    assert.notEqual(run(launcher, local, ambiguous).status, 0);
    for (const changed of [
      { ...original, packageFullName: "Claude_other_x64__publisher" },
      { ...original, managedExecutable: join(value.root, "outside.exe") },
      { ...original, managedAppRoot: join(value.root, "outside", "app") },
    ]) {
      writeFileSync(value.paths.stateFile, JSON.stringify(changed));
      assert.notEqual(run(launcher, local).status, 0);
    }
  } finally {
    cleanup(value.root);
  }
});
