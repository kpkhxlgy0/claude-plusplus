import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const engines = [
  ["PowerShell 7", findExecutable("pwsh.exe")],
  ["Windows PowerShell 5.1", join(system32, "WindowsPowerShell", "v1.0", "powershell.exe")],
].filter(([, path]) => path && existsSync(path));

for (const [engine, executable] of engines) {
  test(`${engine}: builds the exact saved source in place and forwards install arguments`, (t) => {
    const fixture = createFixture(t, { mode: "source" });
    writeFileSync(join(fixture.source, "local-edit.txt"), "uncommitted edit");
    mkdirSync(join(fixture.destination, ".git"), { recursive: true });
    writeFileSync(join(fixture.destination, "keep.txt"), "existing checkout");
    const run = fixture.run(executable, { args: ["--force", "two words"] });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.log, /npm ci --workspaces --include-workspace-root --ignore-scripts/);
    assert.match(run.log, /npm run build/);
    assert.match(run.log, new RegExp(escapeRegex(`cwd=${fixture.source}`)));
    assert.deepEqual(run.cli?.args, ["install", "--force", "two words"]);
    assert.equal(run.cli?.root, fixture.source);
    assert.equal(readFileSync(join(fixture.destination, "keep.txt"), "utf8"), "existing checkout");
    assert.equal(existsSync(join(fixture.destination, "local-edit.txt")), false);
  });

  test(`${engine}: a source script invoked through its Windows short path stays in place`, (t) => {
    const fixture = createFixture(t, { mode: "source" });
    const run = fixture.run(executable, { shortPath: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cli?.root, fixture.source);
    assert.equal(existsSync(fixture.destination), false);
    assert.match(run.log, /shortscript /);
    if (!run.log.includes("~")) t.diagnostic("8.3 names are unavailable; the filesystem returned the canonical path.");
  });

  test(`${engine}: source markers win over a leftover packaged launcher`, (t) => {
    const fixture = createFixture(t, { mode: "source", packagedMarker: true });
    const run = fixture.run(executable);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.log, /npm run build/);
    assert.equal(run.cli?.root, fixture.source);
  });

  test(`${engine}: source installation uses the first Node application on PATH`, (t) => {
    const fixture = createFixture(t, { mode: "source", laterNodeVersion: "v23.11.0" });
    const run = fixture.run(executable);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cli?.root, fixture.source);
    assert.deepEqual(run.cli?.args, ["install"]);
  });

  test(`${engine}: source installation uses the first npm application on PATH`, (t) => {
    const fixture = createFixture(t, { mode: "source", laterNpm: true });
    const run = fixture.run(executable);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.log, /npm ci --workspaces --include-workspace-root --ignore-scripts/);
    assert.match(run.log, /npm run build/);
    assert.equal(run.cli?.root, fixture.source);
  });

  for (const options of [
    { nodeVersion: "v23.11.0", expected: /Node\.js 24 or newer is required.*v23\.11\.0/is },
    { nodeVersion: "not-a-version", expected: /Could not determine the installed Node\.js version: not-a-version/i },
    { nodeVersion: "v24.19.0", nodeVersionExitCode: 7, expected: /Could not determine the installed Node\.js version: v24\.19\.0/i },
  ]) {
    test(`${engine}: keeps the first PATH Node failure with a later supported Node ${JSON.stringify(options)}`, (t) => {
      const fixture = createFixture(t, { mode: "source", laterNodeVersion: "v24.19.0", ...options });
      const run = fixture.run(executable);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, options.expected);
      assert.doesNotMatch(run.log, /npm /);
      assert.equal(run.cli, undefined);
    });
  }

  test(`${engine}: failed npm ci preserves the source lockfile and destination`, (t) => {
    const fixture = createFixture(t, { mode: "source", npmFailure: true });
    const lockfile = readFileSync(join(fixture.source, "package-lock.json"), "utf8");
    const run = fixture.run(executable);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /dependency installation failed/i);
    assert.equal(readFileSync(join(fixture.source, "package-lock.json"), "utf8"), lockfile);
    assert.doesNotMatch(run.log, /npm run build/);
    assert.equal(existsSync(fixture.destination), false);
    assert.equal(run.cli, undefined);
  });

  for (const options of [
    { nodeVersion: undefined, includeNode: false, expected: /Node\.js 24 or newer is required/i },
    { nodeVersion: "v23.11.0", expected: /Node\.js 24 or newer is required.*v23\.11\.0/is },
    { includeNpm: false, expected: /npm is required/i },
  ]) {
    test(`${engine}: rejects unavailable source toolchain ${JSON.stringify(options)}`, (t) => {
      const fixture = createFixture(t, { mode: "source", ...options });
      const run = fixture.run(executable);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, options.expected);
      assert.equal(run.cli, undefined);
    });
  }

  test(`${engine}: extracted release installs with its portable Node and replaces only a managed package`, (t) => {
    const fixture = createFixture(t, { mode: "packaged", includeNode: false });
    createPayload(fixture.destination, { marker: "old" });
    const run = fixture.run(executable, { args: ["--force"] });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.cli?.args, ["install", "--force"]);
    assert.equal(run.cli?.root, fixture.destination);
    assert.equal(run.cli?.node, join(fixture.destination, "toolchain", "node.exe"));
    assert.equal(readFileSync(join(fixture.destination, "marker.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(`${fixture.destination}.previous`, "marker.txt"), "utf8"), "old");
    assert.doesNotMatch(run.log, /npm /);
  });

  test(`${engine}: packaged maintenance failure restores the previous package`, (t) => {
    const fixture = createFixture(t, { mode: "packaged", cliFailure: true });
    createPayload(fixture.destination, { marker: "old" });
    const run = fixture.run(executable);
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.cli?.args, ["install"]);
    assert.equal(readFileSync(join(fixture.destination, "marker.txt"), "utf8"), "old");
    assert.equal(existsSync(`${fixture.destination}.previous`), false);
  });

  test(`${engine}: a saved managed-package installer runs its existing package in place`, (t) => {
    const fixture = createFixture(t, { mode: "packaged", inPlacePackage: true });
    const run = fixture.run(executable);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cli?.root, fixture.destination);
    assert.equal(existsSync(`${fixture.destination}.previous`), false);
  });

  for (const protectedTarget of ["current", "previous"]) {
    test(`${engine}: rollback preserves ${protectedTarget} when maintenance turns it into a Git tree`, (t) => {
      const fixture = createFixture(t, { mode: "packaged", cliFailure: true, protectDuringCli: protectedTarget });
      createPayload(fixture.destination, { marker: "old" });
      const run = fixture.run(executable);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /Git/);
      assert.deepEqual(run.cli?.args, ["install"]);
      assert.equal(readFileSync(join(fixture.destination, "marker.txt"), "utf8"), "new");
      assert.equal(readFileSync(join(`${fixture.destination}.previous`, "marker.txt"), "utf8"), "old");
    });
  }

  test(`${engine}: repeated extracted-release installation succeeds`, (t) => {
    const fixture = createFixture(t, { mode: "packaged" });
    assert.equal(fixture.run(executable).status, 0);
    assert.equal(fixture.run(executable).status, 0);
    const run = fixture.run(executable);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cli?.root, fixture.destination);
  });

  for (const archiveType of ["release", "source"]) {
    test(`${engine}: failed install restores both current and previous ${archiveType} archive`, (t) => {
      const fixture = createFixture(t, { mode: "packaged", cliFailure: true });
      createPayload(fixture.destination, { marker: "old current" });
      createPayload(`${fixture.destination}.previous`, { marker: "old previous", source: archiveType === "source" });
      const run = fixture.run(executable);
      assert.notEqual(run.status, 0);
      assert.deepEqual(run.cli?.args, ["install"]);
      assert.equal(readFileSync(join(fixture.destination, "marker.txt"), "utf8"), "old current");
      assert.equal(readFileSync(join(`${fixture.destination}.previous`, "marker.txt"), "utf8"), "old previous");
    });

    test(`${engine}: successful install rotates a recognized previous ${archiveType} archive`, (t) => {
      const fixture = createFixture(t, { mode: "packaged" });
      createPayload(fixture.destination, { marker: "old current" });
      createPayload(`${fixture.destination}.previous`, { marker: "old previous", source: archiveType === "source" });
      const run = fixture.run(executable);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(fixture.destination, "marker.txt"), "utf8"), "new");
      assert.equal(readFileSync(join(`${fixture.destination}.previous`, "marker.txt"), "utf8"), "old current");
    });
  }

  for (const protection of ["git-root", "git-file", "git-ancestor", "nested-git", "unknown", "previous-unknown", "previous-git", "junction", "ancestor-junction", "previous-junction"]) {
    test(`${engine}: refuses protected package target ${protection} before mutation`, (t) => {
      const fixture = createFixture(t, { mode: "packaged" });
      protectFixture(fixture, protection);
      const run = fixture.run(executable, { args: ["--force"] });
      assert.notEqual(run.status, 0, run.stdout);
      const expected = protection.includes("git") ? /Git/ : protection.includes("junction") ? /linked/ : /nonempty|backup/i;
      assert.match(run.stderr, expected);
      assert.equal(run.cli, undefined);
      assert.equal(readFileSync(fixture.protectedMarker, "utf8"), "protected");
    });
  }

  test(`${engine}: IEX in a clone wrapper downloads and verifies the official stable release`, (t) => {
    const fixture = createFixture(t, { mode: "source", online: true, includeNode: false });
    const run = fixture.run(executable, { entry: "iex-wrapper" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.log, /metadata https:\/\/api\.github\.com\/repos\/kpkhxlgy0\/claude-plusplus\/releases\/latest/);
    assert.match(run.log, /download .*claude-plusplus-9\.8\.7-win-x64\.zip\r?\n/);
    assert.match(run.log, /download .*claude-plusplus-9\.8\.7-win-x64\.zip\.sha256/);
    assert.equal(run.cli?.root, fixture.destination);
    assert.deepEqual(run.cli?.args, ["install"]);
    assert.doesNotMatch(run.log, /npm |old installer/);
    assert.equal(existsSync(join(fixture.destination, "local-edit.txt")), false);
    assert.deepEqual(readdirSync(fixture.downloadTemp), []);
  });

  test(`${engine}: evaluated online text forwards arguments to the installed bundled CLI`, (t) => {
    const fixture = createFixture(t, { mode: "source", online: true, includeNode: false });
    const run = fixture.run(executable, { entry: "iex", args: ["--force", "two words"] });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.cli?.args, ["install", "--force", "two words"]);
    assert.equal(run.cli?.root, fixture.destination);
  });

  for (const failure of ["checksum", "missing-checksum", "wrong-asset", "prerelease", "wrong-identity"]) {
    test(`${engine}: online ${failure} leaves the installed package intact`, (t) => {
      const fixture = createFixture(t, { mode: "source", online: true, onlineFailure: failure });
      createPayload(fixture.destination, { marker: "old" });
      const run = fixture.run(executable, { entry: "iex" });
      assert.notEqual(run.status, 0);
      const expected = { checksum: /hash mismatch/i, "missing-checksum": /checksum asset/i, "wrong-asset": /Windows release asset/i, prerelease: /stable release/i, "wrong-identity": /package identity/i };
      assert.match(run.stderr, expected[failure]);
      assert.equal(readFileSync(join(fixture.destination, "marker.txt"), "utf8"), "old");
      assert.equal(run.cli, undefined);
      if (failure === "checksum") assert.doesNotMatch(run.log, /extract/);
      assert.deepEqual(readdirSync(fixture.downloadTemp), []);
    });
  }

  test(`${engine}: online entry rejects a checkout destination before requesting a release`, (t) => {
    const fixture = createFixture(t, { mode: "source", online: true });
    protectFixture(fixture, "git-root");
    const run = fixture.run(executable, { entry: "iex" });
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.log, /metadata|download|extract/);
    assert.equal(readFileSync(fixture.protectedMarker, "utf8"), "protected");
  });
}

function createFixture(t, options) {
  const tempParent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(tempParent, "claude-plusplus-install-test-")));
  t.after(() => {
    assert.equal(dirname(root).toLowerCase(), tempParent.toLowerCase());
    assert.match(basename(root), /^claude-plusplus-install-test-/);
    removeFixture(root);
  });
  const profile = join(root, "profile");
  const destination = join(profile, ".claude-plusplus", "source");
  const source = options.inPlacePackage ? destination : join(root, "payload with spaces");
  const commands = join(root, "commands");
  const laterCommands = join(root, "later commands");
  const logFile = join(root, "commands.log");
  const cliLog = join(root, "cli.json");
  const downloadTemp = join(root, "download-temp");
  for (const path of [source, commands, laterCommands, downloadTemp, join(profile, "AppData", "Roaming"), join(profile, "AppData", "Local")]) mkdirSync(path, { recursive: true });
  createPayload(source, { source: options.mode === "source", marker: "new", packagedMarker: options.packagedMarker });
  copyFileSync(join(repositoryRoot, "install.ps1"), join(source, "install.ps1"));
  if (options.includeNode !== false) {
    writeNodeCommand(join(commands, "node.cmd"), options.nodeVersion, options.nodeVersionExitCode);
  }
  if (options.laterNodeVersion) {
    writeNodeCommand(join(laterCommands, "node.cmd"), options.laterNodeVersion);
  }
  if (options.includeNpm !== false) {
    writeFileSync(join(commands, "npm.cmd"), `@echo off\r\n>>"%CLAUDE_PLUSPLUS_TEST_LOG%" echo npm %* cwd=%CD%\r\n${options.npmFailure ? 'if "%~1"=="ci" exit /b 7\r\n' : ""}exit /b 0\r\n`, "ascii");
  }
  if (options.laterNpm) {
    writeFileSync(join(laterCommands, "npm.cmd"), "@echo off\r\nexit /b 19\r\n", "ascii");
  }
  const release = join(root, "release-payload");
  if (options.online) {
    createPayload(release, { marker: "downloaded", name: options.onlineFailure === "wrong-identity" ? "another-project" : undefined });
    writeFileSync(join(release, "install.ps1"), 'Add-Content -LiteralPath $env:CLAUDE_PLUSPLUS_TEST_LOG -Value "old installer"; throw "Do not execute this script"');
  }
  const wrapper = join(source, "wrapper.ps1");
  writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
${options.online ? onlineMocks(release, options.onlineFailure) : ""}
$bootstrapText = Get-Content -LiteralPath $env:BOOTSTRAP_SCRIPT -Raw
$forwardArguments = @()
foreach ($argument in ($env:BOOTSTRAP_ARGS | ConvertFrom-Json)) { $forwardArguments += [string]$argument }
$scriptPath = $env:BOOTSTRAP_SCRIPT
if ($env:BOOTSTRAP_SHORT_PATH -eq '1') {
 $scriptPath = (New-Object -ComObject Scripting.FileSystemObject).GetFile($scriptPath).ShortPath
 Add-Content -LiteralPath $env:CLAUDE_PLUSPLUS_TEST_LOG -Value "shortscript $scriptPath"
}
if ($env:BOOTSTRAP_ENTRY -eq 'file') { & $scriptPath @forwardArguments }
elseif ($env:BOOTSTRAP_ENTRY -eq 'iex-wrapper') { Invoke-Expression $bootstrapText }
else { & ([scriptblock]::Create($bootstrapText)) @forwardArguments }
`);
  const fixture = {
    root, source, destination, downloadTemp,
    run(executable, { entry = "file", args = [], shortPath = false } = {}) {
      const cleanEnvironment = { ...process.env };
      for (const key of Object.keys(cleanEnvironment)) {
        if (key.toLowerCase() === "psmodulepath") delete cleanEnvironment[key];
      }
      const run = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...args], {
        cwd: entry === "iex-wrapper" ? source : root,
        encoding: "utf8", windowsHide: true, timeout: 30_000,
        env: { ...cleanEnvironment, USERPROFILE: profile, APPDATA: join(profile, "AppData", "Roaming"), LOCALAPPDATA: join(profile, "AppData", "Local"), PATH: `${commands};${laterCommands};${system32}`, TEMP: downloadTemp, TMP: downloadTemp, CLAUDE_PLUSPLUS_TEST_LOG: logFile, CLAUDE_PLUSPLUS_CLI_LOG: cliLog, CLAUDE_PLUSPLUS_CLI_FAILURE: options.cliFailure ? "1" : "", CLAUDE_PLUSPLUS_PROTECT_DURING_CLI: options.protectDuringCli ?? "", BOOTSTRAP_SHORT_PATH: shortPath ? "1" : "", BOOTSTRAP_ENTRY: entry, BOOTSTRAP_SCRIPT: join(source, "install.ps1"), BOOTSTRAP_ARGS: JSON.stringify(args) },
      });
      return { ...run, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "", cli: existsSync(cliLog) ? JSON.parse(readFileSync(cliLog, "utf8")) : undefined };
    },
  };
  return fixture;
}

function writeNodeCommand(path, version = "v24.19.0", versionExitCode = 0) {
  writeFileSync(path, `@echo off\r\nif "%~1"=="--version" (\r\n echo ${version}\r\n exit /b ${versionExitCode}\r\n)\r\n"${process.execPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "ascii");
}

function createPayload(root, { source = false, marker = "new", packagedMarker = false, name = "claude-plusplus" } = {}) {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "packages", "installer", "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "9.8.7", private: true, workspaces: ["packages/*"], scripts: { build: "fixture" } }));
  writeFileSync(join(root, "package-lock.json"), '{"name":"claude-plusplus","lockfileVersion":3}\n');
  writeFileSync(join(root, "marker.txt"), marker);
  writeFileSync(join(root, "install.ps1"), "# Inert archived installer fixture\n");
  mkdirSync(join(root, "packages", "loader"), { recursive: true });
  writeFileSync(join(root, "packages", "loader", "loader.cjs"), "// inert loader\n");
  mkdirSync(join(root, "packages", "runtime", "dist", "preload"), { recursive: true });
  writeFileSync(join(root, "packages", "runtime", "dist", "main.js"), "// inert runtime\n");
  writeFileSync(join(root, "packages", "runtime", "dist", "preload", "index.js"), "// inert preload\n");
  mkdirSync(join(root, "store"), { recursive: true });
  writeFileSync(join(root, "store", "index.json"), "{}\n");
  const cli = `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'); fs.writeFileSync(process.env.CLAUDE_PLUSPLUS_CLI_LOG, JSON.stringify({root, args:process.argv.slice(2), node:process.execPath})); if (process.env.CLAUDE_PLUSPLUS_PROTECT_DURING_CLI) fs.mkdirSync(path.join(process.env.CLAUDE_PLUSPLUS_PROTECT_DURING_CLI === 'previous' ? root + '.previous' : root, '.GiT'), {recursive:true}); process.exit(process.env.CLAUDE_PLUSPLUS_CLI_FAILURE ? 9 : 0);\n`;
  writeFileSync(join(root, "packages", "installer", "dist", "cli.js"), cli);
  writeFileSync(join(root, "bin", "claudeplusplus.js"), `import '../packages/installer/dist/cli.js';\n`);
  if (source) {
    mkdirSync(join(root, "packages", "installer", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "installer", "src", "cli.ts"), "// source marker\n");
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "runtime", "src", "main.ts"), "// source marker\n");
  }
  if (!source || packagedMarker) {
    mkdirSync(join(root, "toolchain"), { recursive: true });
    try { linkSync(process.execPath, join(root, "toolchain", "node.exe")); }
    catch { copyFileSync(process.execPath, join(root, "toolchain", "node.exe")); }
    writeFileSync(join(root, "bin", "claudeplusplus.cmd"), '@echo off\r\n"%~dp0..\\toolchain\\node.exe" "%~dp0..\\packages\\installer\\dist\\cli.js" %*\r\nexit /b %ERRORLEVEL%\r\n', "ascii");
  }
}

function protectFixture(fixture, protection) {
  const previous = `${fixture.destination}.previous`;
  const protectedRoot = protection.startsWith("previous-") ? previous : fixture.destination;
  mkdirSync(protectedRoot, { recursive: true });
  if (protection.includes("git") || protection === "previous-owned") createPayload(protectedRoot, { marker: "protected package" });
  fixture.protectedMarker = join(protectedRoot, "keep.txt");
  if (protection === "git-root" || protection === "previous-git") mkdirSync(join(protectedRoot, ".GiT"));
  if (protection === "git-file") writeFileSync(join(protectedRoot, ".git"), "gitdir: elsewhere");
  if (protection === "git-ancestor") mkdirSync(join(dirname(fixture.destination), ".git"));
  if (protection === "nested-git") mkdirSync(join(protectedRoot, "nested", ".git"), { recursive: true });
  if (protection.includes("junction")) {
    const linkPath = protection === "ancestor-junction" ? dirname(protectedRoot) : protectedRoot;
    rmSync(linkPath, { recursive: true });
    const linked = join(fixture.root, "linked-keep");
    mkdirSync(linked);
    const keepRoot = protection === "ancestor-junction" ? join(linked, "source") : linked;
    mkdirSync(keepRoot, { recursive: true });
    writeFileSync(join(keepRoot, "keep.txt"), "protected");
    symlinkSync(linked, linkPath, "junction");
  } else writeFileSync(fixture.protectedMarker, "protected");
}

function onlineMocks(release, failure) {
  const zip = join(dirname(release), "release.zip");
  return `
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory('${quote(release)}', '${quote(zip)}')
$archiveName = 'claude-plusplus-9.8.7-win-x64.zip'
$assetBase = 'https://github.com/kpkhxlgy0/claude-plusplus/releases/download/v9.8.7/'
function Invoke-RestMethod {
 param($Uri, $Headers)
 Add-Content -LiteralPath $env:CLAUDE_PLUSPLUS_TEST_LOG -Value "metadata $Uri"
 [pscustomobject]@{ tag_name='v9.8.7'; draft=$false; prerelease=$${failure === "prerelease" ? "true" : "false"}; assets=@(
 [pscustomobject]@{name='${failure === "wrong-asset" ? "claude-plusplus-9.8.7-linux-x64.zip" : "claude-plusplus-9.8.7-win-x64.zip"}'; browser_download_url=($assetBase+$archiveName)}
 ${failure === "missing-checksum" ? "" : "; [pscustomobject]@{name=($archiveName+'.sha256'); browser_download_url=($assetBase+$archiveName+'.sha256')}"}
 ) }
}
function Invoke-WebRequest {
 param($Uri, $OutFile, $Headers, [switch]$UseBasicParsing)
 Add-Content -LiteralPath $env:CLAUDE_PLUSPLUS_TEST_LOG -Value "download $Uri"
 if ($Uri -eq ($assetBase+$archiveName)) { Copy-Item -LiteralPath '${quote(zip)}' -Destination $OutFile }
 elseif ($Uri -eq ($assetBase+$archiveName+'.sha256')) {
  $hash = ${failure === "checksum" ? "('0'*64)" : `(Get-FileHash -LiteralPath '${quote(zip)}' -Algorithm SHA256).Hash`}
  Set-Content -LiteralPath $OutFile -Value "$hash  $archiveName" -Encoding ascii
 } else { throw "Unexpected request: $Uri" }
}
function Expand-Archive {
 param($LiteralPath, $DestinationPath, [switch]$Force)
 Add-Content -LiteralPath $env:CLAUDE_PLUSPLUS_TEST_LOG -Value 'extract'
 Microsoft.PowerShell.Archive\\Expand-Archive -LiteralPath $LiteralPath -DestinationPath $DestinationPath -Force:$Force
}
`;
}

function removeFixture(path) {
  if (lstatSync(path).isSymbolicLink()) { rmSync(path, { force: true }); return; }
  if (lstatSync(path).isDirectory()) {
    for (const child of readdirSync(path)) removeFixture(join(path, child));
    rmSync(path, { recursive: true });
  } else rmSync(path, { force: true });
}
function findExecutable(name) {
  const run = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
  return run.status === 0 ? run.stdout.split(/\r?\n/)[0].trim() : undefined;
}
function quote(value) { return value.replaceAll("'", "''"); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
