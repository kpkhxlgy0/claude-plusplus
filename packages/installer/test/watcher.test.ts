import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWatcherCommand } from "../src/commands/watcher.ts";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";
import {
  readClaudePlusPlusState,
  writeClaudePlusPlusState,
  type ClaudePlusPlusState,
} from "../src/state.ts";
import {
  installWatcher,
  uninstallWatcher,
  WATCHER_TASK_NAMES,
} from "../src/watcher.ts";

test("explicit enable creates logon and five-minute tasks through one generated script", () => {
  const fixture = watcherFixture();
  try {
    const calls: string[][] = [];
    const result = installWatcher(fixture.options, (file, args) => {
      calls.push([file, ...args]);
    });

    assert.equal(result, "scheduled-task");
    assert.equal(calls.some((call) => call.includes("ONLOGON")), true);
    assert.equal(calls.some((call) => call.includes("MINUTE") && call.includes("5")), true);
    const script = readFileSync(fixture.script, "utf8");
    assert.match(script, /set CLAUDE_PLUSPLUS_WATCHER=1/);
    assert.match(script, /call ".*claudeplusplus\.cmd" update --watcher/);
    assert.match(script, /call ".*claudeplusplus\.cmd" repair/);
  } finally {
    fixture.dispose();
  }
});

test("disable removes current and legacy Watcher tasks plus the command script", () => {
  const fixture = watcherFixture();
  try {
    mkdirSync(join(fixture.script, ".."), { recursive: true });
    writeFileSync(fixture.script, "fixture");
    const removed: string[] = [];
    uninstallWatcher(fixture.options, (name) => removed.push(name));

    assert.deepEqual(removed.sort(), [...WATCHER_TASK_NAMES].sort());
    assert.equal(existsSync(fixture.script), false);
  } finally {
    fixture.dispose();
  }
});

test("watcher commands persist enable and disable state", async () => {
  const fixture = watcherFixture();
  try {
    writeClaudePlusPlusState(fixture.options.paths.stateFile, installerState());
    const enabled = await runWatcherCommand("enable", fixture.options.paths, {
      install: () => "scheduled-task",
      uninstall: () => {},
      inspect: () => ({ installed: true, watcher: "scheduled-task", tasks: [], scriptExists: true }),
    });
    assert.equal(enabled.watcher, "scheduled-task");
    assert.equal(readClaudePlusPlusState(fixture.options.paths.stateFile)?.watcher, "scheduled-task");

    const disabled = await runWatcherCommand("disable", fixture.options.paths, {
      install: () => "scheduled-task",
      uninstall: () => {},
      inspect: () => ({ installed: false, watcher: "none", tasks: [], scriptExists: false }),
    });
    assert.equal(disabled.watcher, "none");
    assert.equal(readClaudePlusPlusState(fixture.options.paths.stateFile)?.watcher, "none");
  } finally {
    fixture.dispose();
  }
});

test("watcher command accepts exactly enable, disable, and status", async () => {
  const fixture = watcherFixture();
  try {
    await assert.rejects(runWatcherCommand(undefined, fixture.options.paths), /watcher enable\|disable\|status/);
    await assert.rejects(runWatcherCommand("start", fixture.options.paths), /watcher enable\|disable\|status/);
  } finally {
    fixture.dispose();
  }
});

function watcherFixture() {
  const root = mkdtempSync(join(tmpdir(), "claudepp-watcher-"));
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    USERPROFILE: join(root, "profile"),
  });
  const launcher = join(paths.sourceRoot, "bin", "claudeplusplus.cmd");
  const script = join(paths.roamingRoot, "bin", "watcher.cmd");
  mkdirSync(join(launcher, ".."), { recursive: true });
  writeFileSync(launcher, "@echo off\r\n");
  return {
    options: { paths, launcher },
    script,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function installerState(): ClaudePlusPlusState {
  return {
    schemaVersion: 1,
    claudePlusPlusVersion: "0.2.0",
    packageFullName: "Claude_fixture",
    packageVersion: "1.0.0.0",
    officialAppRoot: "C:\\Official\\app",
    managedAppRoot: "C:\\Managed\\app",
    managedExecutable: "C:\\Managed\\app\\claude.exe",
    asarPath: "C:\\Managed\\app\\resources\\app.asar",
    originalMain: ".vite/build/index.pre.js",
    installedAt: "2026-08-13T00:00:00Z",
    watcher: "none",
  };
}
