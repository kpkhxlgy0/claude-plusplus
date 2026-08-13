import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapRuntime } from "../src/main.ts";

test("registers every Settings management handler once", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-handlers-"));
  try {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const electron = fakeElectron(
      { registerPreloadScript: () => "default" },
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });

    assert.deepEqual([...handlers.keys()].filter((name) => name.startsWith("claudepp:")).sort(), [
      "claudepp:check-claudepp-update",
      "claudepp:copy-text",
      "claudepp:get-config",
      "claudepp:get-tweak-store",
      "claudepp:get-watcher-health",
      "claudepp:install-store-tweak",
      "claudepp:list-tweaks",
      "claudepp:open-external",
      "claudepp:prepare-tweak-submission",
      "claudepp:read-tweak-asset",
      "claudepp:read-tweak-source",
      "claudepp:reload-tweaks",
      "claudepp:renderer-log",
      "claudepp:reveal",
      "claudepp:run-claudepp-update",
      "claudepp:set-auto-update",
      "claudepp:set-tweak-enabled",
      "claudepp:set-update-config",
      "claudepp:set-watcher-enabled",
      "claudepp:tweak-fs",
      "claudepp:user-paths",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers the Claude++ preload additively with modern Electron", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-main-"));
  try {
    const registrations: unknown[] = [];
    const electron = fakeElectron({
      registerPreloadScript(options: unknown) {
        registrations.push(options);
        return "claude-plusplus";
      },
    });

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });

    assert.deepEqual(registrations, [{
      type: "frame",
      id: "claude-plusplus",
      filePath: "C:\\runtime\\preload.js",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves existing preloads when the modern API is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-fallback-"));
  try {
    let preloads = ["C:\\official\\preload.js"];
    const electron = fakeElectron({
      getPreloads: () => preloads,
      setPreloads: (value: string[]) => { preloads = value; },
    });

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });

    assert.deepEqual(preloads, ["C:\\official\\preload.js", "C:\\runtime\\preload.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers the preload on Sessions created after bootstrap", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-session-"));
  try {
    let sessionCreated: ((session: Record<string, unknown>) => void) | undefined;
    const laterRegistrations: unknown[] = [];
    const electron = fakeElectron(
      { registerPreloadScript: () => "default" },
      (listener) => { sessionCreated = listener; },
    );

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    sessionCreated?.({
      registerPreloadScript(options: unknown) {
        laterRegistrations.push(options);
        return "later";
      },
    });

    assert.deepEqual(laterRegistrations, [{
      type: "frame",
      id: "claude-plusplus",
      filePath: "C:\\runtime\\preload.js",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers the default Session only once when session-created fires during readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-default-session-"));
  try {
    let sessionCreated: ((session: Record<string, unknown>) => void) | undefined;
    let registrationCount = 0;
    const defaultSession = {
      registerPreloadScript() {
        registrationCount += 1;
        if (registrationCount > 1) throw new Error("duplicate preload ID");
        return "claude-plusplus";
      },
    };
    const electron = fakeElectron(
      defaultSession,
      (listener) => { sessionCreated = listener; },
    );
    electron.app.whenReady = async () => {
      sessionCreated?.(defaultSession);
    };

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });

    assert.equal(registrationCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers the default Session from the ready event before the official window can be created", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-ready-order-"));
  try {
    let readyListener: (() => void) | undefined;
    let officialWindowCreated = false;
    let registrationWasEarly = false;
    const defaultSession = {
      registerPreloadScript() {
        registrationWasEarly = !officialWindowCreated;
        return "claude-plusplus";
      },
    };
    const electron = fakeElectron(defaultSession);
    electron.app.on = ((event: string, listener: () => void) => {
      if (event === "ready") readyListener = listener;
    }) as typeof electron.app.on;
    electron.app.whenReady = async () => {
      readyListener?.();
      officialWindowCreated = true;
    };

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });

    assert.equal(registrationWasEarly, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records Renderer sandbox settings and preload failures from created web contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-preload-diagnostics-"));
  try {
    let webContentsCreated: ((_event: unknown, webContents: Record<string, unknown>) => void) | undefined;
    let preloadError: ((_event: unknown, path: string, error: Error) => void) | undefined;
    const electron = fakeElectron(
      { registerPreloadScript: () => "default" },
      undefined,
      (listener) => { webContentsCreated = listener; },
    );

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    webContentsCreated?.(undefined, {
      id: 17,
      getType: () => "window",
      getLastWebPreferences: () => ({ sandbox: true, contextIsolation: true }),
      on(event: string, listener: (_event: unknown, path: string, error: Error) => void) {
        if (event === "preload-error") preloadError = listener;
      },
    });
    preloadError?.(undefined, "C:\\runtime\\preload.js", new Error("Cannot find module: node:fs"));

    const log = readFileSync(join(root, "log", "main.log"), "utf8");
    assert.match(log, /web-contents-created id=17 type=window sandbox=true contextIsolation=true/);
    assert.match(log, /preload-error id=17 path=C:\\runtime\\preload\.js: Error: Cannot find module: node:fs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serves the full Tweak catalog and validated Renderer source through separate IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-renderer-ipc-"));
  try {
    const tweakRoot = join(root, "tweaks", "com.example.renderer");
    mkdirSync(tweakRoot, { recursive: true });
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      id: "com.example.renderer",
      name: "Renderer",
      version: "0.2.0",
      githubRepo: "example/renderer",
      scope: "renderer",
    }));
    writeFileSync(join(tweakRoot, "index.js"), "module.exports = { start() {} };\n");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const electron = fakeElectron(
      { registerPreloadScript: () => "default" },
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    const catalog = await handlers.get("claudepp:list-tweaks")?.({}) as Array<{
      manifest: { id: string };
      entry: string;
    }>;
    const source = await handlers.get("claudepp:read-tweak-source")?.({}, catalog[0]?.entry);
    await handlers.get("claudepp:set-tweak-enabled")?.({}, "com.example.renderer", false);
    const disabledCatalog = await handlers.get("claudepp:list-tweaks")?.({}) as Array<{
      manifest: { id: string };
      enabled: boolean;
    }>;
    await handlers.get("claudepp:renderer-log")?.({}, "warn", "sandbox renderer ready");
    await handlers.get("claudepp:renderer-log")?.({}, "debug", "sandbox renderer detail");

    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].manifest.id, "com.example.renderer");
    assert.equal(source, "module.exports = { start() {} };\n");
    assert.equal(catalog[0].entry, join(tweakRoot, "index.js"));
    assert.equal(disabledCatalog[0]?.enabled, false);
    assert.equal(handlers.has("claudepp:reload-tweaks"), true);
    assert.equal(handlers.has("claudepp:renderer-tweaks"), false);
    assert.match(readFileSync(join(root, "log", "renderer.log"), "utf8"), /\[warn\] sandbox renderer ready/);
    assert.match(readFileSync(join(root, "log", "renderer.log"), "utf8"), /\[debug\] sandbox renderer detail/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reload evaluates changed main Tweak source installed through a junction", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-junction-reload-"));
  try {
    const tweaksRoot = join(root, "tweaks");
    const sourceRoot = join(root, "source", "com.example.junction");
    const tweakRoot = join(tweaksRoot, "com.example.junction");
    mkdirSync(tweaksRoot, { recursive: true });
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "manifest.json"), JSON.stringify({
      id: "com.example.junction",
      name: "Junction reload fixture",
      version: "0.2.0",
      githubRepo: "example/junction-reload",
      scope: "main",
      permissions: ["ipc"],
    }));
    const writeTweak = (version: number) => writeFileSync(
      join(sourceRoot, "index.js"),
      `module.exports = { start(api) { api.ipc.handle("version", () => ${version}); } };\n`,
    );
    writeTweak(1);
    try {
      symlinkSync(sourceRoot, tweakRoot, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("directory link creation is not available");
      return;
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const electron = fakeElectron(
      { registerPreloadScript: () => "default" },
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
      (channel) => handlers.delete(channel),
    );

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    const channel = "claudepp:com.example.junction:version";
    assert.equal(await handlers.get(channel)?.({}), 1);

    writeTweak(2);
    await handlers.get("claudepp:reload-tweaks")?.({});

    assert.equal(await handlers.get(channel)?.({}), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxies Renderer filesystem access only for a declared Tweak", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-renderer-fs-"));
  try {
    const allowedRoot = join(root, "tweaks", "com.example.allowed");
    const deniedRoot = join(root, "tweaks", "com.example.denied");
    for (const [dir, id, permissions] of [
      [allowedRoot, "com.example.allowed", ["filesystem"]],
      [deniedRoot, "com.example.denied", []],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({
        id,
        name: id,
        version: "0.2.0",
        githubRepo: "example/tweak",
        scope: "renderer",
        permissions,
      }));
      writeFileSync(join(dir, "index.js"), "module.exports = { start() {} };\n");
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const electron = fakeElectron(
      { registerPreloadScript: () => "default" },
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );
    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    const fsHandler = handlers.get("claudepp:tweak-fs");
    assert.ok(fsHandler);

    await fsHandler({}, "com.example.allowed", "write", "state.txt", "ok");
    assert.equal(
      await fsHandler({}, "com.example.allowed", "read", "state.txt"),
      "ok",
    );
    await assert.rejects(
      async () => await fsHandler({}, "com.example.denied", "read", "state.txt"),
      /filesystem permission/,
    );
    await assert.rejects(
      async () => await fsHandler({}, "com.example.allowed", ["write"], "array.txt", "bad"),
      /request is invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Safe Mode keeps the Renderer management bridge but does not expose Tweaks for startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-safe-"));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.json"), JSON.stringify({ claudePlusPlus: { safeMode: true } }));
    const tweakRoot = join(root, "tweaks", "com.example.safe-mode");
    mkdirSync(tweakRoot, { recursive: true });
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      id: "com.example.safe-mode",
      name: "Safe Mode fixture",
      version: "0.2.0",
      githubRepo: "example/safe-mode",
      scope: "renderer",
    }));
    writeFileSync(join(tweakRoot, "index.js"), "module.exports = { start() {} };\n");
    let registrationCount = 0;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const electron = fakeElectron(
      {
        registerPreloadScript() {
          registrationCount += 1;
          return "claude-plusplus";
        },
      },
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    const payload = await handlers.get("claudepp:list-tweaks")?.({}) as Array<{ enabled: boolean }>;

    assert.equal(registrationCount, 1);
    assert.deepEqual(payload.map((item) => item.enabled), [false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeElectron(
  defaultSession: Record<string, unknown>,
  captureSessionCreated?: (listener: (session: Record<string, unknown>) => void) => void,
  captureWebContentsCreated?: (
    listener: (_event: unknown, webContents: Record<string, unknown>) => void,
  ) => void,
  captureIpcHandle?: (channel: string, handler: (...args: unknown[]) => unknown) => void,
  captureIpcRemoveHandler?: (channel: string) => void,
): typeof import("electron") {
  return {
    app: {
      whenReady: async () => {},
      on(event: string, listener: (session: Record<string, unknown>) => void) {
        if (event === "session-created") captureSessionCreated?.(listener);
        if (event === "web-contents-created") {
          captureWebContentsCreated?.(listener as unknown as (
            event: unknown,
            webContents: Record<string, unknown>,
          ) => void);
        }
      },
    },
    session: { defaultSession },
    ipcMain: {
      handle(channel: string, handler: (...args: unknown[]) => unknown) {
        captureIpcHandle?.(channel, handler);
      },
      removeHandler(channel: string) {
        captureIpcRemoveHandler?.(channel);
      },
    },
  } as unknown as typeof import("electron");
}
