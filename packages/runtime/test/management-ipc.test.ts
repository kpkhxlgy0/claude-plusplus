import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installManagementIpc } from "../src/management-ipc.ts";

test("management IPC persists a valid Tweak toggle before reload and disposes every handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-management-ipc-"));
  try {
    const tweak = join(root, "tweaks", "com.example.toggle");
    mkdirSync(tweak, { recursive: true });
    writeFileSync(join(tweak, "manifest.json"), JSON.stringify({
      id: "com.example.toggle",
      name: "Toggle",
      version: "0.2.0",
      githubRepo: "example/toggle",
      scope: "renderer",
    }));
    writeFileSync(join(tweak, "index.js"), "module.exports = { start() {} };\n");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const removed: string[] = [];
    let persistedBeforeReload = false;
    const dispose = installManagementIpc({
      electron: {
        ipcMain: {
          handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
          removeHandler: (channel: string) => { removed.push(channel); },
        },
        shell: {},
        clipboard: {},
      } as unknown as typeof import("electron"),
      userRoot: root,
      tweaksRoot: join(root, "tweaks"),
      configFile: join(root, "config.json"),
      sourceRoot: join(root, "source"),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async reloadTweaks(reason) {
        const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
        persistedBeforeReload = reason === "enabled-toggle" &&
          config.tweaks["com.example.toggle"].enabled === false;
      },
    });

    await handlers.get("claudepp:set-tweak-enabled")?.({}, "com.example.toggle", false);
    dispose();

    assert.equal(persistedBeforeReload, true);
    assert.deepEqual(removed.sort(), [...handlers.keys()].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
