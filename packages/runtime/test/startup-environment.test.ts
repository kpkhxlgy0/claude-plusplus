import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
  StartupEnvironmentConfig,
  TweakLogger,
  TweakManifest,
} from "@claude-plusplus/sdk";
import {
  initializeStartupEnvironment,
  type StartupEnvironmentAppBridge,
} from "../src/startup-environment.ts";
import {
  startupEnvironmentSnapshotPath,
  writeStartupEnvironmentSnapshot,
} from "../src/startup-environment-store.ts";

test("applies one complete eligible overlay and restores its exact baseline", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.one", ["EXAMPLE_MAX", "EXAMPLE_WINDOW"]);
    const config = createConfig({ EXAMPLE_MAX: "272000", EXAMPLE_WINDOW: "250000" });
    installTweak(root, manifest, config);
    const env: NodeJS.ProcessEnv = { EXAMPLE_MAX: "original", EXAMPLE_WINDOW: undefined };

    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });

    assert.deepEqual(env, { EXAMPLE_MAX: "272000", EXAMPLE_WINDOW: "250000" });
    assert.deepEqual(service.getStatus(manifest.id), {
      saved: config,
      applied: config,
      restartRequired: false,
    });
    service.restoreBaseline();
    assert.deepEqual(env, { EXAMPLE_MAX: "original", EXAMPLE_WINDOW: undefined });
  });
});

test("skips every enabled snapshot participating in an ownership conflict", () => {
  withRoot((root) => {
    const one = createManifest("com.example.one", ["SHARED", "ONE"]);
    const two = createManifest("com.example.two", ["SHARED"]);
    installTweak(root, one, createConfig({ SHARED: "one", ONE: "one" }));
    installTweak(root, two, createConfig({ SHARED: "two" }));
    const env: NodeJS.ProcessEnv = {};

    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });

    assert.equal(env.SHARED, undefined);
    assert.equal(env.ONE, undefined);
    assert.equal(service.getStatus(one.id).applied, null);
    assert.equal(service.getStatus(two.id).applied, null);
    assert.match(service.getStatus(one.id).error ?? "", /SHARED.*com\.example\.one.*com\.example\.two/i);
    assert.match(service.getStatus(two.id).error ?? "", /SHARED.*com\.example\.one.*com\.example\.two/i);
  });
});

test("Safe Mode, global disable, internal disable, missing source, and malformed snapshots fail closed", () => {
  withRoot((root) => {
    const safe = createManifest("com.example.safe", ["SAFE_KEY"]);
    installTweak(root, safe, createConfig({ SAFE_KEY: "override" }));
    writeRuntimeConfig(root, { safeMode: true });
    const safeEnv: NodeJS.ProcessEnv = { SAFE_KEY: "baseline" };
    initializeStartupEnvironment({ userRoot: root, env: safeEnv, log: silentLog() });
    assert.equal(safeEnv.SAFE_KEY, "baseline");
  });

  withRoot((root) => {
    const disabled = createManifest("com.example.global-disabled", ["GLOBAL_KEY"]);
    const config = createConfig({ GLOBAL_KEY: "override" });
    installTweak(root, disabled, config);
    writeRuntimeConfig(root, { disabledTweaks: [disabled.id] });
    const env: NodeJS.ProcessEnv = { GLOBAL_KEY: "baseline" };
    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });
    assert.equal(env.GLOBAL_KEY, "baseline");
    assert.deepEqual(service.getStatus(disabled.id), {
      saved: config,
      applied: null,
      restartRequired: true,
    });
  });

  withRoot((root) => {
    const disabled = createManifest("com.example.internal-disabled", ["INTERNAL_KEY"]);
    const config = createConfig({ INTERNAL_KEY: "preserved" }, false);
    installTweak(root, disabled, config);
    const env: NodeJS.ProcessEnv = { INTERNAL_KEY: "baseline" };
    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });
    assert.equal(env.INTERNAL_KEY, "baseline");
    assert.deepEqual(service.getStatus(disabled.id), {
      saved: config,
      applied: config,
      restartRequired: false,
    });
  });

  withRoot((root) => {
    writeRawSnapshot(root, "com.example.missing", {
      version: 1,
      enabled: true,
      variables: { MISSING_KEY: "override" },
    });
    const env: NodeJS.ProcessEnv = { MISSING_KEY: "baseline" };
    initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });
    assert.equal(env.MISSING_KEY, "baseline");
  });

  withRoot((root) => {
    const malformed = createManifest("com.example.malformed", ["MALFORMED_KEY"]);
    installTweak(root, malformed);
    writeRawSnapshot(root, malformed.id, { version: 2, enabled: true, variables: {} });
    const env: NodeJS.ProcessEnv = { MALFORMED_KEY: "baseline" };
    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });
    assert.equal(env.MALFORMED_KEY, "baseline");
    assert.match(service.getStatus(malformed.id).error ?? "", /version/i);
  });
});

test("save writes the complete next-launch snapshot without mutating the applied environment", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.save", ["SAVE_MAX", "SAVE_WINDOW"]);
    installTweak(root, manifest);
    const env: NodeJS.ProcessEnv = { SAVE_MAX: "baseline" };
    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });
    const lease = service.createApiLease(manifest);
    const next = createConfig({ SAVE_MAX: "272000", SAVE_WINDOW: "250000" });

    const status = lease.api.save(next);

    assert.deepEqual(env, { SAVE_MAX: "baseline" });
    assert.deepEqual(status, { saved: next, applied: null, restartRequired: true });
    assert.deepEqual(lease.api.getStatus(), status);
    assert.throws(
      () => lease.api.save(createConfig({ SAVE_MAX: "300000" })),
      /SAVE_WINDOW/,
    );
    assert.deepEqual(lease.api.getStatus(), status);
  });
});

test("refuses startup environment access without the manifest permission", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.denied", ["DENIED_KEY"]);
    manifest.permissions = ["ipc"];
    delete manifest.startupEnvironment;
    const service = initializeStartupEnvironment({ userRoot: root, env: {}, log: silentLog() });

    assert.throws(() => service.createApiLease(manifest), /permission/i);
  });
});

test("rolls back a complete Tweak group when one environment assignment fails", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.assignment", ["FIRST_KEY", "FAIL_KEY"]);
    installTweak(root, manifest, createConfig({ FIRST_KEY: "first", FAIL_KEY: "fail" }));
    const target: NodeJS.ProcessEnv = { FIRST_KEY: "baseline" };
    const env = new Proxy(target, {
      set(object, key, value) {
        if (key === "FAIL_KEY") throw new Error("assignment rejected");
        return Reflect.set(object, key, value);
      },
    });

    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });

    assert.deepEqual(target, { FIRST_KEY: "baseline" });
    assert.equal(service.getStatus(manifest.id).applied, null);
    assert.match(service.getStatus(manifest.id).error ?? "", /FIRST_KEY.*FAIL_KEY|FAIL_KEY.*FIRST_KEY/i);
  });
});

test("an unexpected initializer failure restores earlier overlays and returns an inert service", () => {
  withRoot((root) => {
    const first = createManifest("com.example.first", ["FIRST_KEY"]);
    const second = createManifest("com.example.second", ["FAIL_KEY"]);
    installTweak(root, first, createConfig({ FIRST_KEY: "override" }));
    installTweak(root, second, createConfig({ FAIL_KEY: "override" }));
    const target: NodeJS.ProcessEnv = {};
    const env = new Proxy(target, {
      set(object, key, value) {
        if (key === "FAIL_KEY") throw new Error("assignment failure");
        return Reflect.set(object, key, value);
      },
      deleteProperty(object, key) {
        if (key === "FAIL_KEY") throw new Error("unexpected rollback failure");
        return Reflect.deleteProperty(object, key);
      },
    });
    const messages: string[] = [];

    const service = initializeStartupEnvironment({ userRoot: root, env, log: recordingLog(messages) });

    assert.deepEqual(target, {});
    assert.match(service.getStatus(first.id).error ?? "", /unexpected rollback failure/i);
    assert.equal(messages.some((message) => /unexpected rollback failure/i.test(message)), true);
  });
});

test("a diagnostics write failure cannot prevent Claude startup", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.log-failure", ["LOG_KEY"]);
    installTweak(root, manifest);
    writeRawSnapshot(root, manifest.id, { version: 2, enabled: true, variables: {} });
    const env: NodeJS.ProcessEnv = { LOG_KEY: "baseline" };
    const throwLog = () => {
      throw new Error("log unavailable");
    };
    const log: TweakLogger = { debug: throwLog, info: throwLog, warn: throwLog, error: throwLog };

    assert.doesNotThrow(() => initializeStartupEnvironment({ userRoot: root, env, log }));
    assert.equal(env.LOG_KEY, "baseline");
  });
});

test("relaunch requires one app bridge and restores the baseline before scheduling", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.relaunch", ["RELAUNCH_KEY"]);
    installTweak(root, manifest, createConfig({ RELAUNCH_KEY: "override" }));
    const env: NodeJS.ProcessEnv = { RELAUNCH_KEY: "baseline" };
    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog() });
    const lease = service.createApiLease(manifest);
    const calls: string[] = [];
    const app: StartupEnvironmentAppBridge = {
      relaunch() {
        assert.equal(env.RELAUNCH_KEY, "baseline");
        calls.push("relaunch");
      },
      quit() {
        calls.push("quit");
      },
    };

    assert.throws(() => lease.api.relaunch(), /unavailable/i);
    service.attachAppBridge(app);
    service.attachAppBridge(app);
    assert.throws(
      () => service.attachAppBridge({ relaunch() {}, quit() {} }),
      /already attached/i,
    );
    lease.api.relaunch();
    assert.deepEqual(calls, ["relaunch", "quit"]);
  });
});

test("a failed relaunch scheduling restores the launch overlay", () => {
  withRoot((root) => {
    const manifest = createManifest("com.example.relaunch-failure", ["RELAUNCH_KEY"]);
    installTweak(root, manifest, createConfig({ RELAUNCH_KEY: "override" }));
    const env: NodeJS.ProcessEnv = { RELAUNCH_KEY: "baseline" };
    const app: StartupEnvironmentAppBridge = {
      relaunch() {
        assert.equal(env.RELAUNCH_KEY, "baseline");
        throw new Error("schedule failed");
      },
      quit() {
        assert.fail("quit must not run after scheduling fails");
      },
    };
    const service = initializeStartupEnvironment({ userRoot: root, env, log: silentLog(), app });
    const lease = service.createApiLease(manifest);

    assert.throws(() => lease.api.relaunch(), /schedule failed/);
    assert.equal(env.RELAUNCH_KEY, "override");
  });
});

function createManifest(id: string, keys: string[]): TweakManifest {
  return {
    id,
    name: id,
    version: "0.1.0",
    githubRepo: "example/startup-env",
    scope: "main",
    main: "index.js",
    permissions: ["startup-environment"],
    startupEnvironment: { keys },
  };
}

function createConfig(
  variables: Record<string, string>,
  enabled = true,
): StartupEnvironmentConfig {
  return { enabled, variables };
}

function installTweak(
  root: string,
  manifest: TweakManifest,
  config?: StartupEnvironmentConfig,
): void {
  const dir = join(root, "tweaks", manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, manifest.main ?? "index.js"), "module.exports = { start() {} };\n", "utf8");
  if (config) writeStartupEnvironmentSnapshot(root, manifest, config);
}

function writeRuntimeConfig(
  root: string,
  options: { safeMode?: boolean; disabledTweaks?: string[] },
): void {
  const tweaks = Object.fromEntries((options.disabledTweaks ?? []).map((id) => [id, { enabled: false }]));
  writeFileSync(join(root, "config.json"), `${JSON.stringify({
    claudePlusPlus: { safeMode: options.safeMode === true },
    tweaks,
  }, null, 2)}\n`, "utf8");
}

function writeRawSnapshot(root: string, id: string, value: unknown): void {
  const path = startupEnvironmentSnapshotPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function silentLog(): TweakLogger {
  return recordingLog([]);
}

function recordingLog(messages: string[]): TweakLogger {
  const record = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  return { debug: record, info: record, warn: record, error: record };
}

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-startup-env-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
