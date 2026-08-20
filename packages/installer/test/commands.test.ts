import assert from "node:assert/strict";
import * as asar from "@electron/asar";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inspectClaudePlusPlusLoader } from "../src/asar.ts";
import {
  installClaudePlusPlus,
  resolveInstallerSourceRoot,
  type InstallCommandDeps,
} from "../src/commands/install.ts";
import { getDebugInfo } from "../src/commands/debug.ts";
import { doctorClaudePlusPlus } from "../src/commands/doctor.ts";
import { launchClaudePlusPlus } from "../src/commands/launch.ts";
import { repairClaudePlusPlus } from "../src/commands/repair.ts";
import { parseSafeModeArguments, runSafeMode } from "../src/commands/safe-mode.ts";
import { getClaudePlusPlusStatus } from "../src/commands/status.ts";
import { uninstallClaudePlusPlus } from "../src/commands/uninstall.ts";
import type { ClaudeInstall } from "../src/platform.ts";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";
import { readClaudePlusPlusState } from "../src/state.ts";

test("resolves the release source root from packages/installer/dist", () => {
  const releaseRoot = resolve("fixture-release");
  const installUrl = pathToFileURL(
    join(releaseRoot, "packages", "installer", "dist", "commands", "install.js"),
  ).href;

  assert.equal(resolveInstallerSourceRoot(installUrl), releaseRoot);
});

test("installs a real managed mirror, Loader, Runtime, state, and shortcut idempotently", async () => {
  const fixture = await createFixture();
  try {
    const first = await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.equal(first.status, "installed");
    assert.ok(state);
    assert.equal(state.watcher, "none");
    assert.equal(state.packageVersion, "1.0.0.0");
    assert.equal(readFileSync(join(fixture.paths.runtime, "main.js"), "utf8"), "module.exports = {};\n");
    assert.equal(readFileSync(fixture.paths.shortcutFile, "utf8"), state.managedExecutable);
    assert.equal(inspectClaudePlusPlusLoader(state.asarPath)?.originalMain, ".vite/build/index.pre.js");
    assert.equal(readFixtureFuse(state.managedExecutable, 4), "0");

    writeFileSync(join(state.managedAppRoot, "managed-only.txt"), "keep");
    writeFileSync(join(fixture.install.appRoot, "late-official.txt"), "do-not-copy");
    const second = await installClaudePlusPlus(fixture.options, fixture.deps);

    assert.equal(second.status, "current");
    assert.equal(readFileSync(join(state.managedAppRoot, "managed-only.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(state.managedAppRoot, "late-official.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default install retains every old managed mirror", async () => {
  const fixture = await createFixture();
  try {
    const oldMirrorA = join(fixture.paths.storeApps, "Claude_old_a");
    const oldMirrorB = join(fixture.paths.storeApps, "Claude_old_b");
    mkdirSync(oldMirrorA, { recursive: true });
    mkdirSync(oldMirrorB, { recursive: true });
    writeFileSync(join(oldMirrorA, "sentinel.txt"), "keep-a");
    writeFileSync(join(oldMirrorB, "sentinel.txt"), "keep-b");

    await installClaudePlusPlus(fixture.options, fixture.deps);

    assert.equal(readFileSync(join(oldMirrorA, "sentinel.txt"), "utf8"), "keep-a");
    assert.equal(readFileSync(join(oldMirrorB, "sentinel.txt"), "utf8"), "keep-b");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit all-old cleanup is confined to non-current managed mirror directories", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const currentMirror = join(fixture.paths.storeApps, fixture.install.packageFullName);
    const oldMirrorA = join(fixture.paths.storeApps, "Claude_old_a");
    const oldMirrorB = join(fixture.paths.storeApps, "Claude_old_b");
    const storeFile = join(fixture.paths.storeApps, "keep.txt");
    const outside = join(fixture.root, "outside-cleanup");
    mkdirSync(oldMirrorA, { recursive: true });
    mkdirSync(oldMirrorB, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(oldMirrorA, "sentinel.txt"), "remove-a");
    writeFileSync(join(oldMirrorB, "sentinel.txt"), "remove-b");
    writeFileSync(storeFile, "keep-store-file");
    writeFileSync(join(outside, "sentinel.txt"), "keep-outside");

    const result = await installClaudePlusPlus(
      { ...fixture.options, cleanupAllOld: true },
      fixture.deps,
    );

    assert.equal(result.status, "current");
    assert.equal(existsSync(oldMirrorA), false);
    assert.equal(existsSync(oldMirrorB), false);
    assert.equal(existsSync(currentMirror), true);
    assert.equal(readFileSync(storeFile, "utf8"), "keep-store-file");
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "keep-outside");
    assert.equal(existsSync(fixture.install.appRoot), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit all-old cleanup also runs during a fresh install", async () => {
  const fixture = await createFixture();
  try {
    const oldMirror = join(fixture.paths.storeApps, "Claude_old");
    mkdirSync(oldMirror, { recursive: true });
    writeFileSync(join(oldMirror, "sentinel.txt"), "remove");

    const result = await installClaudePlusPlus(
      { ...fixture.options, cleanupAllOld: true },
      fixture.deps,
    );

    assert.equal(result.status, "installed");
    assert.equal(existsSync(oldMirror), false);
    assert.equal(existsSync(join(fixture.paths.storeApps, fixture.install.packageFullName)), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit all-old cleanup waits for a successful install", async () => {
  const fixture = await createFixture();
  try {
    const oldMirror = join(fixture.paths.storeApps, "Claude_old");
    mkdirSync(oldMirror, { recursive: true });
    writeFileSync(join(oldMirror, "sentinel.txt"), "keep-on-failure");

    await assert.rejects(
      installClaudePlusPlus(
        { ...fixture.options, cleanupAllOld: true },
        {
          ...fixture.deps,
          createShortcut: async () => {
            throw new Error("shortcut failed");
          },
        },
      ),
      /shortcut failed/,
    );

    assert.equal(readFileSync(join(oldMirror, "sentinel.txt"), "utf8"), "keep-on-failure");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refreshes Runtime during a same-version maintenance install", async () => {
  const fixture = await createFixture();
  try {
    const first = await installClaudePlusPlus(fixture.options, fixture.deps);
    assert.equal(first.status, "installed");
    writeFileSync(
      join(fixture.options.sourceRoot, "packages", "runtime", "dist", "main.js"),
      "module.exports = { revision: 2 };\n",
    );
    writeFileSync(
      join(fixture.options.sourceRoot, "packages", "runtime", "dist", "preload", "index.js"),
      "module.exports = { revision: 2 };\n",
    );

    const second = await installClaudePlusPlus(fixture.options, fixture.deps);

    assert.equal(second.status, "current");
    assert.equal(
      readFileSync(join(fixture.paths.runtime, "main.js"), "utf8"),
      "module.exports = { revision: 2 };\n",
    );
    assert.equal(
      readFileSync(join(fixture.paths.runtime, "preload", "index.js"), "utf8"),
      "module.exports = { revision: 2 };\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repair restores a missing Runtime and a missing Loader", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state);
    rmSync(join(fixture.paths.runtime, "main.js"), { force: true });
    copyFileSync(fixture.install.asarPath, state.asarPath);

    await repairClaudePlusPlus(fixture.options, fixture.deps);

    assert.equal(existsSync(join(fixture.paths.runtime, "main.js")), true);
    assert.equal(inspectClaudePlusPlusLoader(state.asarPath)?.metadata.loaderVersion, "0.2.9");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Watcher repair is a no-op while the managed installation is current", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    writeFileSync(
      join(fixture.options.sourceRoot, "packages", "runtime", "dist", "main.js"),
      "module.exports = { revision: 2 };\n",
    );

    await repairClaudePlusPlus({ ...fixture.options, watcher: true }, fixture.deps);

    assert.equal(readFileSync(join(fixture.paths.runtime, "main.js"), "utf8"), "module.exports = {};\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("maintenance preserves an explicitly enabled Watcher across a new Claude package", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state);
    writeFileSync(fixture.paths.stateFile, JSON.stringify({ ...state, watcher: "scheduled-task" }));
    fixture.install.packageFullName = "Claude_fixture_v2_x64__test";
    fixture.install.packageVersion = "2.0.0.0";

    await installClaudePlusPlus(fixture.options, fixture.deps);

    assert.equal(readClaudePlusPlusState(fixture.paths.stateFile)?.watcher, "scheduled-task");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("maintenance migrates defaults while preserving config, Tweak Junctions, data, and old mirrors", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const oldMirror = join(fixture.paths.storeApps, "Claude_old");
    const tweakSource = join(fixture.root, "internal-tweak");
    const tweakLink = join(fixture.paths.tweaks, "com.example.internal");
    mkdirSync(oldMirror, { recursive: true });
    mkdirSync(tweakSource, { recursive: true });
    mkdirSync(fixture.paths.tweaks, { recursive: true });
    mkdirSync(fixture.paths.tweakData, { recursive: true });
    writeFileSync(join(oldMirror, "sentinel.txt"), "keep mirror");
    writeFileSync(join(tweakSource, "manifest.json"), "{}\n");
    writeFileSync(join(fixture.paths.tweakData, "settings.json"), "keep data\n");
    symlinkSync(tweakSource, tweakLink, "junction");
    writeFileSync(fixture.paths.configFile, JSON.stringify({
      claudePlusPlus: { safeMode: true },
      tweaks: { "com.example.internal": { enabled: false, prompt: "keep prompt" } },
      privateSetting: { keep: true },
    }));

    await installClaudePlusPlus(fixture.options, fixture.deps);

    const config = JSON.parse(readFileSync(fixture.paths.configFile, "utf8"));
    assert.equal(config.claudePlusPlus.safeMode, true);
    assert.equal(config.claudePlusPlus.autoUpdate, false);
    assert.equal(config.claudePlusPlus.updateChannel, "stable");
    assert.equal(config.tweaks["com.example.internal"].enabled, false);
    assert.equal(config.tweaks["com.example.internal"].prompt, "keep prompt");
    assert.equal(config.privateSetting.keep, true);
    assert.deepEqual(config.tweakUpdateChecks, {});
    assert.equal(existsSync(tweakLink), true);
    assert.equal(readFileSync(join(fixture.paths.tweakData, "settings.json"), "utf8"), "keep data\n");
    assert.equal(readFileSync(join(oldMirror, "sentinel.txt"), "utf8"), "keep mirror");
    assert.equal(readClaudePlusPlusState(fixture.paths.stateFile)?.watcher, "none");
    assert.equal(existsSync(join(fixture.paths.roamingRoot, "bin", "watcher.cmd")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Safe Mode arguments accept default/on/off/status and reject conflicts", () => {
  assert.equal(parseSafeModeArguments([]), "on");
  assert.equal(parseSafeModeArguments(["--on"]), "on");
  assert.equal(parseSafeModeArguments(["--off"]), "off");
  assert.equal(parseSafeModeArguments(["--status"]), "status");
  assert.throws(() => parseSafeModeArguments(["--on", "--off"]), /only one/i);
  assert.throws(() => parseSafeModeArguments(["--on", "--on"]), /duplicate/i);
  assert.throws(() => parseSafeModeArguments(["--wat"]), /unknown/i);
});

test("Safe Mode status is read-only and mutations preserve config then refresh the marker", async () => {
  const fixture = await createFixture();
  try {
    mkdirSync(dirname(fixture.paths.configFile), { recursive: true });
    writeFileSync(fixture.paths.configFile, JSON.stringify({
      claudePlusPlus: { safeMode: false, privateSetting: "keep" },
      tweaks: { "com.example.keep": { enabled: false } },
      untouched: { value: 7 },
    }));
    const before = readFileSync(fixture.paths.configFile, "utf8");

    assert.deepEqual(runSafeMode("status", fixture.paths), {
      safeMode: false,
      changed: false,
      restartRequired: false,
    });
    assert.equal(readFileSync(fixture.paths.configFile, "utf8"), before);
    assert.equal(existsSync(fixture.paths.tweaks), false);

    assert.deepEqual(runSafeMode("on", fixture.paths, { now: () => 100 }), {
      safeMode: true,
      changed: true,
      restartRequired: true,
    });
    const config = JSON.parse(readFileSync(fixture.paths.configFile, "utf8"));
    assert.equal(config.claudePlusPlus.privateSetting, "keep");
    assert.equal(config.tweaks["com.example.keep"].enabled, false);
    assert.equal(config.untouched.value, 7);
    const marker = join(fixture.paths.tweaks, ".claudepp-safe-mode-reload");
    assert.equal(readFileSync(marker, "utf8"), "100");

    assert.deepEqual(runSafeMode("on", fixture.paths, { now: () => 200 }), {
      safeMode: true,
      changed: false,
      restartRequired: true,
    });
    assert.equal(readFileSync(marker, "utf8"), "200");

    assert.deepEqual(runSafeMode("off", fixture.paths, { now: () => 300 }), {
      safeMode: false,
      changed: true,
      restartRequired: true,
    });
    assert.equal(readFileSync(marker, "utf8"), "300");
    assert.equal(
      JSON.parse(readFileSync(fixture.paths.configFile, "utf8")).claudePlusPlus.safeMode,
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Safe Mode status on a fresh profile creates nothing", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(runSafeMode("status", fixture.paths), {
      safeMode: false,
      changed: false,
      restartRequired: false,
    });
    assert.equal(existsSync(fixture.paths.configFile), false);
    assert.equal(existsSync(fixture.paths.tweaks), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("status, debug, doctor, and launch expose the managed installation safely", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const status = getClaudePlusPlusStatus(fixture.paths);
    const debug = getDebugInfo(fixture.paths);
    const doctor = await doctorClaudePlusPlus(fixture.paths, { discover: fixture.deps.discover });
    let launched = "";
    let detached = false;

    launchClaudePlusPlus(fixture.paths, (executable) => ({
      unref() {
        launched = executable;
        detached = true;
      },
    }));

    assert.equal(status.installed, true);
    assert.equal(debug.stateFile, fixture.paths.stateFile);
    assert.equal(doctor.checks.every((check) => check.ok), true);
    assert.deepEqual(doctor.checks.map((check) => check.name), [
      "official-claude",
      "state",
      "managed-app",
      "loader",
      "runtime",
      "settings-runtime",
      "integrity-fuse",
      "config",
      "tweak-store",
      "watcher",
      "safe-mode",
    ]);
    assert.equal(doctor.checks.find((check) => check.name === "watcher")?.detail, "optional; not installed");
    for (const check of doctor.checks) {
      assert.doesNotMatch(
        check.detail,
        /protocol|composer|session|trust|assets?|hash|compatib/i,
        check.name,
      );
    }
    assert.equal(JSON.stringify(doctor).includes(fixture.root), false);
    assert.equal(launched, status.managedExecutable);
    assert.equal(detached, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor rejects a configured Watcher whose artifacts are incomplete", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state);
    writeFileSync(fixture.paths.stateFile, JSON.stringify({ ...state, watcher: "scheduled-task" }));
    assert.equal(existsSync(join(fixture.paths.roamingRoot, "bin", "watcher.cmd")), false);

    const doctor = await doctorClaudePlusPlus(fixture.paths, { discover: fixture.deps.discover });
    const watcherCheck = doctor.checks.find((check) => check.name === "watcher");

    assert.deepEqual(watcherCheck, {
      name: "watcher",
      ok: false,
      detail: "configured but incomplete",
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("status and doctor reject a managed app whose integrity fuse is enabled", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state);
    writeFixtureFuse(state.managedExecutable, 4, "1");

    const status = getClaudePlusPlusStatus(fixture.paths);
    const doctor = await doctorClaudePlusPlus(fixture.paths, { discover: fixture.deps.discover });
    const fuseCheck = doctor.checks.find((check) => check.name === "integrity-fuse");

    assert.equal(status.installed, false);
    assert.equal(status.integrityFuseReady, false);
    assert.equal(fuseCheck?.ok, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall removes every managed mirror when state is missing", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const orphan = join(fixture.paths.storeApps, "Claude_orphan", "app");
    mkdirSync(orphan, { recursive: true });
    rmSync(fixture.paths.stateFile, { force: true });

    const result = await uninstallClaudePlusPlus(
      { paths: fixture.paths },
      { uninstallWatcher: () => {} },
    );

    assert.deepEqual(result, { warnings: [] });
    assert.equal(existsSync(fixture.paths.storeApps), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("purge removes fixed mirrors and roaming data when state JSON is malformed", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    writeFileSync(fixture.paths.stateFile, "{ malformed", "utf8");
    const outside = join(fixture.root, "outside", "sentinel.txt");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "keep", "utf8");

    const result = await uninstallClaudePlusPlus(
      { paths: fixture.paths, purge: true },
      { uninstallWatcher: () => {} },
    );

    assert.deepEqual(result, { warnings: [] });
    assert.equal(existsSync(fixture.paths.storeApps), false);
    assert.equal(existsSync(fixture.paths.roamingRoot), false);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall reports fixed-root cleanup failures and still removes runtime state", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const result = await uninstallClaudePlusPlus({ paths: fixture.paths }, {
      uninstallWatcher: () => {},
      cleanupWindowsManagedArtifacts: async (paths) => [
        `Could not remove Claude++ managed Store mirrors at ${paths.storeApps}. ` +
        "Close Claude++ and rerun uninstall. locked managed mirror",
      ],
    });
    assert.deepEqual(result.warnings, [
      `Could not remove Claude++ managed Store mirrors at ${fixture.paths.storeApps}. ` +
      "Close Claude++ and rerun uninstall. locked managed mirror",
    ]);
    assert.equal(existsSync(fixture.paths.runtime), false);
    assert.equal(existsSync(fixture.paths.stateFile), false);
    assert.equal(existsSync(fixture.paths.shortcutFile), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall preflights every destructive target before Watcher cleanup", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const tweakSentinel = join(fixture.paths.tweaks, "keep.txt");
    const stateSentinel = join(fixture.root, "outside", "state-sentinel.json");
    const shortcutSentinel = join(fixture.root, "outside", "shortcut-sentinel.lnk");
    const cacheSentinel = join(fixture.paths.cache, "keep.txt");
    for (const sentinel of [tweakSentinel, stateSentinel, shortcutSentinel, cacheSentinel]) {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, "keep", "utf8");
    }
    writeFileSync(fixture.paths.stateFile, "{ malformed", "utf8");

    const substitutions = [
      {
        paths: { ...fixture.paths, runtime: fixture.paths.tweaks },
        error: /exact Claude\+\+ Runtime directory/i,
      },
      {
        paths: { ...fixture.paths, stateFile: stateSentinel },
        error: /exact Claude\+\+ state file/i,
      },
      {
        paths: { ...fixture.paths, shortcutFile: shortcutSentinel },
        error: /exact Claude\+\+ Start Menu shortcut/i,
      },
      {
        paths: { ...fixture.paths, storeApps: fixture.paths.cache },
        error: /exact Claude\+\+ store-apps root/i,
      },
    ];

    for (const substitution of substitutions) {
      let watcherCalls = 0;
      await assert.rejects(
        uninstallClaudePlusPlus(
          { paths: substitution.paths },
          { uninstallWatcher: () => { watcherCalls += 1; } },
        ),
        substitution.error,
      );
      assert.equal(watcherCalls, 0);
      for (const sentinel of [tweakSentinel, stateSentinel, shortcutSentinel, cacheSentinel]) {
        assert.equal(readFileSync(sentinel, "utf8"), "keep");
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall preserves Tweak data by default and purge removes it", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    mkdirSync(fixture.paths.tweaks, { recursive: true });
    mkdirSync(fixture.paths.tweakData, { recursive: true });
    writeFileSync(join(fixture.paths.tweaks, "keep.txt"), "keep");
    writeFileSync(join(fixture.paths.tweakData, "keep.txt"), "keep");
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state);

    await uninstallClaudePlusPlus(
      { paths: fixture.paths, purge: false },
      { uninstallWatcher: () => {} },
    );

    assert.equal(existsSync(state.managedAppRoot), false);
    assert.equal(existsSync(fixture.paths.runtime), false);
    assert.equal(existsSync(fixture.paths.stateFile), false);
    assert.equal(existsSync(fixture.paths.shortcutFile), false);
    assert.equal(existsSync(join(fixture.paths.tweaks, "keep.txt")), true);
    assert.equal(existsSync(join(fixture.paths.tweakData, "keep.txt")), true);

    await uninstallClaudePlusPlus(
      { paths: fixture.paths, purge: true },
      { uninstallWatcher: () => {} },
    );
    assert.equal(existsSync(fixture.paths.roamingRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall rejects a forged state path outside Claude++ roots", async () => {
  const fixture = await createFixture();
  try {
    const outside = join(fixture.root, "outside-app");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "keep");
    mkdirSync(dirname(fixture.paths.stateFile), { recursive: true });
    writeFileSync(fixture.paths.stateFile, JSON.stringify({
      schemaVersion: 1,
      claudePlusPlusVersion: "0.2.0",
      packageFullName: fixture.install.packageFullName,
      packageVersion: fixture.install.packageVersion,
      officialAppRoot: fixture.install.appRoot,
      managedAppRoot: outside,
      managedExecutable: join(outside, "claude.exe"),
      asarPath: join(outside, "resources", "app.asar"),
      originalMain: ".vite/build/index.pre.js",
      installedAt: "2026-08-11T12:00:00.000Z",
    }));

    await assert.rejects(
      uninstallClaudePlusPlus(
        { paths: fixture.paths, purge: false },
        { uninstallWatcher: () => {} },
      ),
      /outside.*store-apps/i,
    );
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "keep");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall attempts Watcher cleanup even when installer state is missing", async () => {
  const fixture = await createFixture();
  try {
    let cleanups = 0;
    await uninstallClaudePlusPlus({ paths: fixture.paths }, {
      uninstallWatcher: () => {
        cleanups += 1;
      },
    });
    assert.equal(cleanups, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "claudepp-commands-"));
  const appRoot = join(root, "official", "app");
  const resourcesPath = join(appRoot, "resources");
  const asarSource = join(root, "asar-source");
  mkdirSync(join(asarSource, ".vite", "build"), { recursive: true });
  mkdirSync(resourcesPath, { recursive: true });
  writeFileSync(join(appRoot, "claude.exe"), createElectronFixtureBinary());
  writeFileSync(
    join(asarSource, "package.json"),
    JSON.stringify({ name: "fixture", main: ".vite/build/index.pre.js" }),
  );
  writeFileSync(join(asarSource, ".vite", "build", "index.pre.js"), "module.exports = {};\n");
  const asarPath = join(resourcesPath, "app.asar");
  await asar.createPackage(asarSource, asarPath);
  const install: ClaudeInstall = {
    packageFullName: "Claude_fixture_x64__test",
    packageVersion: "1.0.0.0",
    installLocation: join(root, "official"),
    appRoot,
    executablePath: join(appRoot, "claude.exe"),
    resourcesPath,
    asarPath,
  };
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    USERPROFILE: join(root, "profile"),
  });
  const sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, "packages", "runtime", "dist", "preload"), { recursive: true });
  mkdirSync(join(sourceRoot, "packages", "loader"), { recursive: true });
  writeFileSync(join(sourceRoot, "packages", "runtime", "dist", "main.js"), "module.exports = {};\n");
  writeFileSync(join(sourceRoot, "packages", "runtime", "dist", "preload", "index.js"), "module.exports = {};\n");
  copyFileSync(
    resolve("packages", "loader", "loader.cjs"),
    join(sourceRoot, "packages", "loader", "loader.cjs"),
  );
  const deps: InstallCommandDeps = {
    discover: async () => install,
    createShortcut: async (target, shortcut) => {
      mkdirSync(dirname(shortcut), { recursive: true });
      writeFileSync(shortcut, target);
    },
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  };
  return {
    root,
    install,
    paths,
    deps,
    options: { paths, sourceRoot },
  };
}

function createElectronFixtureBinary(): Buffer {
  return Buffer.concat([
    Buffer.from("fixture-executable"),
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii"),
    Buffer.from([1, 9]),
    Buffer.from("010011011", "ascii"),
  ]);
}

function readFixtureFuse(path: string, index: number): string {
  const binary = readFileSync(path);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
  const sentinelOffset = binary.indexOf(sentinel);
  assert.notEqual(sentinelOffset, -1);
  return String.fromCharCode(binary[sentinelOffset + sentinel.length + 2 + index]);
}

function writeFixtureFuse(path: string, index: number, value: string): void {
  const binary = readFileSync(path);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
  const sentinelOffset = binary.indexOf(sentinel);
  assert.notEqual(sentinelOffset, -1);
  binary[sentinelOffset + sentinel.length + 2 + index] = value.charCodeAt(0);
  writeFileSync(path, binary);
}
