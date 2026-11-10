import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { buildWindowsMirrorCleanupScript, cleanupOldWindowsMirrors } from "../src/windows-mirror-cleanup.ts";

const native = process.platform === "win32";
const currentName = "Claude_26.1103.7773.0_x64__2p2nqsd0c76g0";
const oldName = "Claude_26.1023.6123.0_x64__2p2nqsd0c76g0";
const olderName = "Claude_26.1023.5000.0_x64__2p2nqsd0c76g0";

interface Result {
  removed: string[];
  retained: string[];
  planned: string[];
  warnings: string[];
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function fixture(prefix = "claude-mirror-cleanup-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const localAppData = join(root, "local");
  const managedRoot = join(localAppData, "claude-plusplus", "store-apps");
  const appRoot = join(managedRoot, currentName, "app");
  const stateFile = join(root, "state.json");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ managedAppRoot: appRoot, claudePlusPlusVersion: "0.3.11" }));
  const mirror = (name: string) => {
    const target = join(managedRoot, name);
    mkdirSync(join(target, "app"), { recursive: true });
    writeFileSync(join(target, "app", "sentinel.txt"), name);
    return target;
  };
  const run = (options: { dryRun?: boolean; prelude?: string; appRoot?: string; localAppData?: string } = {}): Result => {
    const script = buildWindowsMirrorCleanupScript({
      appRoot: options.appRoot ?? appRoot,
      stateFile,
      localAppData: options.localAppData ?? localAppData,
      dryRun: options.dryRun,
    });
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `${options.prelude ?? "function Get-CimInstance { @() }"}\n${script}`,
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(output.trim()) as Result;
  };
  return { root, localAppData, managedRoot, appRoot, stateFile, mirror, run,
    dispose: () => rmSync(root, { recursive: true }) };
}

test("Windows mirror cleanup keeps current, used, newer and unrecognized directories", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const used = f.mirror(olderName);
    const newer = f.mirror("Claude_26.1104.1.0_x64__2p2nqsd0c76g0");
    const foreign = f.mirror("Claude_26.1.1.0_x64__aaaaaaaaaaaaa");
    const arm = f.mirror("Claude_26.1.1.0_arm64__2p2nqsd0c76g0");
    const unknown = f.mirror("backup");
    const result = f.run({ prelude: `function Get-CimInstance {
      [pscustomobject]@{ProcessId=123; Name='claude.exe'; ExecutablePath=${quote(join(used, "app", "claude.exe"))}; CommandLine='claude.exe'}
    }` });
    assert.deepEqual(result.removed, [old]);
    assert.deepEqual(result.planned, []);
    assert.deepEqual(result.warnings, []);
    for (const kept of [join(f.managedRoot, currentName), used, newer, foreign, arm, unknown]) {
      assert.ok(result.retained.includes(kept), `retained ${kept}`);
      assert.ok(existsSync(kept));
    }
    assert.equal(existsSync(old), false);
  } finally { f.dispose(); }
});

test("dry run reports safe old targets while leaving their files intact", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const result = f.run({ dryRun: true });
    assert.deepEqual(result.planned, [old]);
    assert.deepEqual(result.removed, []);
    assert.equal(readFileSync(join(old, "app", "sentinel.txt"), "utf8"), oldName);
  } finally { f.dispose(); }
});

test("command-line references protect a mirror even when the executable is outside it", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const result = f.run({ prelude: `function Get-CimInstance {
      [pscustomobject]@{ProcessId=123; Name='node.exe'; ExecutablePath='C:\\node.exe'; CommandLine=${quote(`node "${join(old, "app", "worker.js")}" --secret=DO-NOT-LOG`)}}
    }` });
    assert.deepEqual(result.removed, []);
    assert.ok(result.retained.includes(old));
    assert.deepEqual(result.warnings, []);
    assert.ok(existsSync(old));
    assert.ok(!JSON.stringify(result).includes("DO-NOT-LOG"));
  } finally { f.dispose(); }
});

for (const [name, prelude] of [
  ["failed process query", "function Get-CimInstance { throw 'DO-NOT-LOG query failure' }"],
  ["unknown Claude executable", "function Get-CimInstance { [pscustomobject]@{ProcessId=123;Name='claude.exe';ExecutablePath=$null;CommandLine='claude.exe'} }"],
  ["unknown Electron command line", "function Get-CimInstance { [pscustomobject]@{ProcessId=123;Name='electron.exe';ExecutablePath='C:\\electron.exe';CommandLine=$null} }"],
  ["unknown node command line", "function Get-CimInstance { [pscustomobject]@{ProcessId=123;Name='node.exe';ExecutablePath='C:\\node.exe';CommandLine=$null} }"],
] as const) {
  test(`${name} preserves all old mirrors without exposing process details`, { skip: !native }, () => {
    const f = fixture();
    try {
      const old = f.mirror(oldName);
      const result = f.run({ prelude });
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.planned, []);
      assert.ok(existsSync(old));
      assert.ok(result.warnings.length > 0);
      assert.ok(!JSON.stringify(result).includes("DO-NOT-LOG"));
    } finally { f.dispose(); }
  });
}

test("mismatched persisted state preserves every mirror", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    writeFileSync(f.stateFile, JSON.stringify({ managedAppRoot: join(f.root, "other-app") }));
    const result = f.run();
    assert.deepEqual(result.removed, []);
    assert.ok(existsSync(old));
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

test("state change during process inspection stops deletion", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const result = f.run({ prelude: `function Get-CimInstance {
      [IO.File]::WriteAllText(${quote(f.stateFile)}, '{"managedAppRoot":"changed"}'); @()
    }` });
    assert.deepEqual(result.removed, []);
    assert.ok(existsSync(old));
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

test("state and process use are checked again before each deletion", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const older = f.mirror(olderName);
    const result = f.run({ prelude: `$script:queries=0
      function Get-CimInstance {
        $script:queries++
        if ($script:queries -gt 1) {
          [pscustomobject]@{ProcessId=123;Name='claude.exe';ExecutablePath=${quote(join(old, "app", "claude.exe"))};CommandLine='claude.exe'}
        }
      }` });
    assert.deepEqual(result.removed, [older]);
    assert.ok(result.retained.includes(old));
    assert.ok(existsSync(old));
    assert.equal(existsSync(older), false);
  } finally { f.dispose(); }
});

test("a native deletion refusal remains visible and does not throw", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const result = f.run({ prelude: `function Get-CimInstance { @() }
      function Remove-Item { param($LiteralPath, [switch]$Recurse, $ErrorAction); throw 'locked' }` });
    assert.deepEqual(result.removed, []);
    assert.ok(result.retained.includes(old));
    assert.ok(existsSync(old));
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

test("a descendant junction preserves its mirror and external files", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const external = join(f.root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "external");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `New-Item -ItemType Junction -Path ${quote(join(old, "app", "junction"))} -Target ${quote(external)} | Out-Null`,
    ]);
    const result = f.run();
    assert.deepEqual(result.removed, []);
    assert.ok(result.retained.includes(old));
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "external");
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

test("a junction managed root cannot widen cleanup into its destination", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const destination = join(f.root, "redirected");
    const redirectedLocal = join(f.root, "redirected-local");
    mkdirSync(join(redirectedLocal, "claude-plusplus"), { recursive: true });
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Move-Item -LiteralPath ${quote(f.managedRoot)} -Destination ${quote(destination)}; New-Item -ItemType Junction -Path ${quote(join(redirectedLocal, "claude-plusplus", "store-apps"))} -Target ${quote(destination)} | Out-Null`,
    ]);
    const redirectedApp = join(redirectedLocal, "claude-plusplus", "store-apps", currentName, "app");
    writeFileSync(f.stateFile, JSON.stringify({ managedAppRoot: redirectedApp }));
    const result = f.run({ localAppData: redirectedLocal, appRoot: redirectedApp });
    assert.deepEqual(result.removed, []);
    assert.ok(existsSync(join(destination, oldName)));
    assert.equal(existsSync(old), false);
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

for (const malformed of ["relative\\app", "C:\\..\\app", "\\\\?\\C:\\app", "C:\\safe.\\app", "C:\\safe\\app:stream"]) {
  test(`unsafe current path is rejected: ${malformed}`, { skip: !native }, () => {
    const f = fixture();
    try {
      const old = f.mirror(oldName);
      const result = f.run({ appRoot: malformed });
      assert.deepEqual(result.removed, []);
      assert.ok(existsSync(old));
      assert.ok(result.warnings.length > 0);
    } finally { f.dispose(); }
  });
}

test("standalone installs leave similarly named sibling folders intact", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const appRoot = join(f.root, "standalone", "app");
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(f.stateFile, JSON.stringify({ managedAppRoot: appRoot }));
    const result = f.run({ appRoot });
    assert.deepEqual(result.removed, []);
    assert.ok(existsSync(old));
  } finally { f.dispose(); }
});

test("public cleanup is a no-op off Windows", { skip: native }, () => {
  assert.deepEqual(cleanupOldWindowsMirrors({ appRoot: "/outside", stateFile: "/missing", quiet: true }), {
    removed: [], retained: [], planned: [], warnings: [],
  });
});


test("state changes after a successful deletion preserve remaining mirrors", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const older = f.mirror(olderName);
    const result = f.run({ prelude: `function Get-CimInstance { @() }
      function Remove-Item {
        param($LiteralPath, [switch]$Recurse, $ErrorAction)
        Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Recurse -ErrorAction Stop
        [IO.File]::WriteAllText(${quote(f.stateFile)}, '{"managedAppRoot":"changed"}')
      }` });
    assert.deepEqual(result.removed, [older]);
    assert.ok(result.retained.includes(old));
    assert.ok(existsSync(old));
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

for (const missing of ["state", "current"] as const) {
  test(`missing ${missing} preserves every old mirror`, { skip: !native }, () => {
    const f = fixture();
    try {
      const old = f.mirror(oldName);
      rmSync(missing === "state" ? f.stateFile : f.appRoot, { recursive: true });
      const result = f.run();
      assert.deepEqual(result.removed, []);
      assert.ok(existsSync(old));
      assert.ok(result.warnings.length > 0);
    } finally { f.dispose(); }
  });
}

test("a target junction preserves its external destination", { skip: !native }, () => {
  const f = fixture();
  try {
    const external = join(f.root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "external");
    const target = join(f.managedRoot, oldName);
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `New-Item -ItemType Junction -Path ${quote(target)} -Target ${quote(external)} | Out-Null`,
    ]);
    const result = f.run();
    assert.deepEqual(result.removed, []);
    assert.ok(result.retained.includes(target));
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "external");
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

test("literal paths preserve quoting and wildcard characters without widening deletion", { skip: !native }, () => {
  const f = fixture("claude-mirror-cleanup-'[literal]-");
  try {
    const old = f.mirror(oldName);
    const external = join(f.root, "keep.txt");
    writeFileSync(external, "outside managed root");
    const result = f.run();
    assert.deepEqual(result.removed, [old]);
    assert.deepEqual(result.warnings, []);
    assert.equal(readFileSync(external, "utf8"), "outside managed root");
  } finally { f.dispose(); }
});

test("a junction introduced during process inspection blocks deletion", { skip: !native }, () => {
  const f = fixture();
  try {
    const old = f.mirror(oldName);
    const external = join(f.root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "external");
    const result = f.run({ prelude: `function Get-CimInstance {
      New-Item -ItemType Junction -Path ${quote(join(old, "app", "junction"))} -Target ${quote(external)} | Out-Null
      @()
    }` });
    assert.deepEqual(result.removed, []);
    assert.ok(result.retained.includes(old));
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "external");
    assert.ok(result.warnings.length > 0);
  } finally { f.dispose(); }
});

for (const scenario of ["spawn failure", "invalid JSON", "malformed result"] as const) {
  test(`public cleanup reports ${scenario} without throwing`, { skip: !native }, () => {
    const stub = mock.method(childProcess, "execFileSync", () => {
      if (scenario === "spawn failure") throw new Error("private process failure");
      return scenario === "invalid JSON" ? "invalid JSON" : '{"removed":[42]}';
    });
    syncBuiltinESMExports();
    try {
      const result = cleanupOldWindowsMirrors({ appRoot: "C:\\fixture\\app", stateFile: "C:\\fixture\\state.json", quiet: true });
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.planned, []);
      assert.equal(result.warnings.length, 1);
      assert.ok(!JSON.stringify(result).includes("private process failure"));
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
