import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakLogger, TweakManifest } from "@claude-plusplus/sdk";
import {
  createMainTweakApiLease,
  createRendererTweakApiLease,
} from "../src/tweak-api.ts";
import { initializeStartupEnvironment } from "../src/startup-environment.ts";

test("Main API persists storage and gates filesystem operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-main-api-"));
  try {
    const startupEnvironment = initializeStartupEnvironment({ userRoot: root, env: {}, log });
    const withoutFs = createMainTweakApiLease({
      manifest: manifest([]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
    });
    withoutFs.api.storage.set("enabled", true);
    await assert.rejects(() => withoutFs.api.fs.write("state.txt", "bad"), /filesystem permission/);
    await withoutFs.dispose();

    const withFs = createMainTweakApiLease({
      manifest: manifest(["filesystem"]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
    });
    assert.equal(withFs.api.storage.get("enabled"), true);
    await withFs.api.fs.write("state.txt", "ok");
    assert.equal(await withFs.api.fs.read("state.txt"), "ok");
    await withFs.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Renderer API mirrors storage and proxies permitted filesystem calls", async () => {
  const values = new Map<string, string>();
  const invoked: unknown[][] = [];
  const ipc = rendererIpcBridge(async (channel, ...args) => {
    invoked.push([channel, ...args]);
    if (channel === "claudepp:tweak-fs") return args[1] === "exists";
    return undefined;
  });
  const first = createRendererTweakApiLease({
    manifest: manifest(["filesystem"]),
    log,
    storage: localStorageBridge(values),
    ipc,
  });
  first.api.storage.set("template", "value");
  await first.api.fs.write("template.txt", "ok");
  assert.equal(await first.api.fs.exists("template.txt"), true);
  await first.dispose();

  const second = createRendererTweakApiLease({
    manifest: manifest(["filesystem"]),
    log,
    storage: localStorageBridge(values),
    ipc: rendererIpcBridge(async () => undefined),
  });
  assert.equal(second.api.storage.get("template"), "value");
  assert.deepEqual(invoked, [
    ["claudepp:tweak-fs", "com.example.api", "write", "template.txt", "ok"],
    ["claudepp:tweak-fs", "com.example.api", "exists", "template.txt"],
  ]);
  await second.dispose();
});

test("Renderer API only exposes Claude Sessions with its focused permission", async () => {
  const withoutPermission = createRendererTweakApiLease({
    manifest: manifest([]),
    log,
    storage: localStorageBridge(new Map()),
    ipc: rendererIpcBridge(async () => undefined),
  });
  assert.equal(withoutPermission.api.claude, undefined);
  await withoutPermission.dispose();

  const invoked: unknown[][] = [];
  const withPermission = createRendererTweakApiLease({
    manifest: manifest(["claude-sessions"]),
    log,
    storage: localStorageBridge(new Map()),
    ipc: rendererIpcBridge(async (channel, ...args) => {
      invoked.push([channel, ...args]);
      if (channel.endsWith("_getSession")) {
        return { cwd: "D:\\workspace\\sgproj" };
      }
      if (channel.endsWith("_getTranscript")) {
        return [{
          type: "assistant",
          message: {
            id: "resp-file-link",
            role: "assistant",
            content: [{
              type: "text",
              text: "[Waiting.prefab:8](file:///D:/workspace/sgproj/Assets/Waiting.prefab#L8)",
            }],
          },
        }];
      }
      return "D:\\workspace\\sgproj\\Assets\\Waiting.prefab";
    }),
  });
  assert.equal(
    await withPermission.api.claude?.sessions.resolveFile("local-session-id", "Waiting.prefab"),
    "D:\\workspace\\sgproj\\Assets\\Waiting.prefab",
  );
  assert.equal(
    await withPermission.api.claude?.sessions.resolveReference(
      "local-session-id",
      "resp-file-link",
      "Waiting.prefab",
      0,
      1,
    ),
    "file:///D:/workspace/sgproj/Assets/Waiting.prefab#L8",
  );
  assert.equal(
    await withPermission.api.claude?.sessions.getWorkspaceRoot("local-session-id"),
    "D:\\workspace\\sgproj",
  );
  assert.deepEqual(invoked, [
    [
      "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_resolveSessionFile",
      "local-session-id",
      "Waiting.prefab",
    ],
    [
      "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getTranscript",
      "local-session-id",
    ],
    [
      "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getSession",
      "local-session-id",
    ],
  ]);
  await withPermission.dispose();
});

test("Renderer API revokes retained Claude Sessions references on disposal", async () => {
  let invokeCount = 0;
  const lease = createRendererTweakApiLease({
    manifest: manifest(["claude-sessions"]),
    log,
    storage: localStorageBridge(new Map()),
    ipc: rendererIpcBridge(async () => {
      invokeCount += 1;
      return "D:\\workspace\\sgproj\\Assets\\Waiting.prefab";
    }),
  });
  const sessions = lease.api.claude?.sessions;
  assert.ok(sessions);

  await lease.dispose();

  await assert.rejects(
    () => sessions.resolveFile("local-session-id", "Waiting.prefab"),
    /disposed/,
  );
  await assert.rejects(
    () => sessions.resolveReference("local-session-id", "resp-file-link", "Waiting.prefab", 0, 1),
    /disposed/,
  );
  await assert.rejects(
    () => sessions.getWorkspaceRoot("local-session-id"),
    /disposed/,
  );
  assert.equal(invokeCount, 0);
});

test("Main API gates startup environment permission and revokes retained references", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-startup-api-"));
  try {
    const startupEnvironment = initializeStartupEnvironment({ userRoot: root, env: {}, log });
    const withoutPermission = createMainTweakApiLease({
      manifest: manifest([]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
    });
    assert.equal(withoutPermission.api.startupEnvironment, undefined);
    await withoutPermission.dispose();

    const withPermission = createMainTweakApiLease({
      manifest: startupManifest(),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
    });
    const retained = withPermission.api.startupEnvironment;
    assert.ok(retained);
    const config = { enabled: true, variables: { EXAMPLE_MAX: "272000" } };
    assert.deepEqual(retained.save(config), {
      saved: config,
      applied: null,
      restartRequired: true,
    });

    await withPermission.dispose();

    assert.throws(() => retained.getStatus(), /disposed/);
    assert.throws(() => retained.save(config), /disposed/);
    assert.throws(() => retained.relaunch(), /disposed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Renderer API never exposes startup environment", async () => {
  const lease = createRendererTweakApiLease({
    manifest: startupManifest(),
    log,
    storage: localStorageBridge(new Map()),
    ipc: rendererIpcBridge(async () => undefined),
  });

  assert.equal(lease.api.startupEnvironment, undefined);
  await lease.dispose();
});

const log: TweakLogger = { debug() {}, info() {}, warn() {}, error() {} };

function manifest(permissions: TweakManifest["permissions"]): TweakManifest {
  return {
    id: "com.example.api",
    name: "API",
    version: "0.2.0",
    githubRepo: "example/api",
    scope: "both",
    permissions,
  };
}

function startupManifest(): TweakManifest {
  return {
    ...manifest(["startup-environment"]),
    startupEnvironment: { keys: ["EXAMPLE_MAX"] },
  };
}

function localStorageBridge(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function mainIpcBridge() {
  return {
    on(): void {},
    removeListener(): void {},
    handle(): void {},
    removeHandler(): void {},
    getWebContents: () => [],
  };
}

function rendererIpcBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
) {
  return {
    on(): void {},
    removeListener(): void {},
    send(): void {},
    invoke,
  };
}
