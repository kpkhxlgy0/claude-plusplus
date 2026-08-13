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

test("Main API persists storage and gates filesystem operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-main-api-"));
  try {
    const withoutFs = createMainTweakApiLease({
      manifest: manifest([]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
    });
    withoutFs.api.storage.set("enabled", true);
    await assert.rejects(() => withoutFs.api.fs.write("state.txt", "bad"), /filesystem permission/);
    await withoutFs.dispose();

    const withFs = createMainTweakApiLease({
      manifest: manifest(["filesystem"]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
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
