import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const powershell = resolvePowerShell();
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

test("installs a packaged release without probing system Node.js", (t) => {
  const result = runInstaller(t, { mode: "packaged", pathMode: "system-only" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /packaged install/);
  assert.doesNotMatch(result.log, /node |npm /);
});

test("builds and installs a source checkout with Node.js 24", (t) => {
  const result = runInstaller(t, { mode: "source", nodeVersion: "v24.19.0" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /npm ci --workspaces --include-workspace-root --ignore-scripts/);
  assert.match(result.log, /npm run build/);
  assert.match(result.log, /node .*bin[\\/]claudeplusplus\.js install/);
  assert.equal(existsSync(join(result.destination, "bin", "claudeplusplus.js")), true);
});

test("rejects source installation when Node.js is missing", (t) => {
  const result = runInstaller(t, { mode: "source", pathMode: "system-only" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 24 or newer is required/i);
  assert.doesNotMatch(result.log, /npm /);
});

test("rejects source installation with Node.js 23", (t) => {
  const result = runInstaller(t, { mode: "source", nodeVersion: "v23.11.0" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 24 or newer is required.*v23\.11\.0/is);
  assert.doesNotMatch(result.log, /npm /);
});

test("rejects source installation when npm is missing", (t) => {
  const result = runInstaller(t, {
    mode: "source",
    nodeVersion: "v24.19.0",
    includeNpm: false,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm is required/i);
  assert.doesNotMatch(result.log, /npm /);
});

test("rejects a payload without either launcher", (t) => {
  const result = runInstaller(t, { mode: "invalid", nodeVersion: "v24.19.0" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claudeplusplus\.cmd/);
  assert.match(result.stderr, /claudeplusplus\.js/);
  assert.equal(result.log, "");
});

function runInstaller(t, options) {
  const testRoot = mkdtempSync(join(tmpdir(), "claude-plusplus-install-test-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  const source = join(testRoot, "payload");
  const profile = join(testRoot, "profile");
  const commands = join(testRoot, "commands");
  const logFile = join(testRoot, "commands.log");
  const destination = join(profile, ".claude-plusplus", "source");
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(commands, { recursive: true });
  mkdirSync(join(profile, "AppData", "Roaming"), { recursive: true });
  mkdirSync(join(profile, "AppData", "Local"), { recursive: true });
  copyFileSync(join(repositoryRoot, "install.ps1"), join(source, "install.ps1"));

  if (options.mode === "packaged") {
    writeCommand(
      join(source, "bin", "claudeplusplus.cmd"),
      '@echo off\r\n>>"%CLAUDE_PLUSPLUS_TEST_LOG%" echo packaged %*\r\nexit /b 0\r\n',
    );
  } else if (options.mode === "source") {
    writeFileSync(join(source, "bin", "claudeplusplus.js"), "process.exit(0);\n");
  }

  if (options.nodeVersion) {
    writeCommand(
      join(commands, "node.cmd"),
      [
        "@echo off",
        'if "%~1"=="--version" (',
        "  echo %FAKE_NODE_VERSION%",
        "  exit /b 0",
        ")",
        '>>"%CLAUDE_PLUSPLUS_TEST_LOG%" echo node %*',
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
  }
  if (options.nodeVersion && options.includeNpm !== false) {
    writeCommand(
      join(commands, "npm.cmd"),
      '@echo off\r\n>>"%CLAUDE_PLUSPLUS_TEST_LOG%" echo npm %*\r\nexit /b 0\r\n',
    );
  }

  const path = options.pathMode === "system-only" ? system32 : `${commands};${system32}`;
  const run = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(source, "install.ps1")],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        APPDATA: join(profile, "AppData", "Roaming"),
        CLAUDE_PLUSPLUS_TEST_LOG: logFile,
        FAKE_NODE_VERSION: options.nodeVersion ?? "",
        LOCALAPPDATA: join(profile, "AppData", "Local"),
        PATH: path,
        USERPROFILE: profile,
      },
    },
  );

  return {
    destination,
    log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
    status: run.status,
    stderr: run.stderr,
    stdout: run.stdout,
  };
}

function writeCommand(path, source) {
  writeFileSync(path, source, "ascii");
}

function resolvePowerShell() {
  const result = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`PowerShell 7 is required for installer tests: ${result.stderr}`);
  return result.stdout.split(/\r?\n/, 1)[0].trim();
}
