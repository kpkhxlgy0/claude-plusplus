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
import type { TweakManifest, TweakMcpServer } from "@claude-plusplus/sdk";
import { bootstrapRuntime, initializeRuntimeModule } from "../src/main.ts";
import { initializeStartupEnvironment } from "../src/startup-environment.ts";
import { initializeClaudeCodeSettings } from "../src/claude-code-settings.ts";

test("Runtime initializer installs the Desktop observer synchronously before yielding to Claude", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-early-mcp-"));
  try {
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(calls);
    let bootstrapService: FakeDesktopMcpService | undefined;

    initializeRuntimeModule({
      electron: fakeElectron(fakeSession()),
      userRoot: root,
      runtimeRoot: "C:\\runtime",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      createDesktopMcpService: () => desktopMcpService,
      bootstrap: async (deps) => {
        calls.push("bootstrap");
        bootstrapService = deps.desktopMcpService as FakeDesktopMcpService;
      },
    });
    calls.push("original-entry");

    assert.deepEqual(calls, ["install-early", "bootstrap", "original-entry"]);
    assert.equal(bootstrapService, desktopMcpService);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime initializer logs Desktop observer setup errors and supplies an unsupported service", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-mcp-fallback-"));
  try {
    let bootstrapService: FakeDesktopMcpService | undefined;
    const brokenService = new FakeDesktopMcpService([], new Error("observer failed"));

    assert.doesNotThrow(() => initializeRuntimeModule({
      electron: fakeElectron(fakeSession()),
      userRoot: root,
      runtimeRoot: "C:\\runtime",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      createDesktopMcpService: () => brokenService,
      bootstrap: async (deps) => {
        bootstrapService = deps.desktopMcpService as FakeDesktopMcpService;
      },
    }));
    assert.ok(bootstrapService);
    assert.notEqual(bootstrapService, brokenService);

    const lease = bootstrapService.createMcpApiLease(mainManifest("com.example.unsupported"));
    await assert.rejects(() => lease.api.registerServer(mcpServer()), /unsupported/);
    assert.match(readFileSync(join(root, "log", "main.log"), "utf8"), /observer failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers every Settings management handler once", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-handlers-"));
  try {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const electron = fakeElectron(
      fakeSession(() => "default"),
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });

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
    const electron = fakeElectron(fakeSession((options) => {
      registrations.push(options);
      return "claude-plusplus";
    }));

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });

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
      ...fakeSession(),
      registerPreloadScript: undefined,
      getPreloads: () => preloads,
      setPreloads: (value: string[]) => { preloads = value; },
    });

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });

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
      fakeSession(() => "default"),
      (listener) => { sessionCreated = listener; },
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });
    sessionCreated?.(fakeSession((options) => {
      laterRegistrations.push(options);
      return "later";
    }));

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
    const defaultSession = fakeSession(() => {
      registrationCount += 1;
      if (registrationCount > 1) throw new Error("duplicate preload ID");
      return "claude-plusplus";
    });
    const electron = fakeElectron(
      defaultSession,
      (listener) => { sessionCreated = listener; },
    );
    electron.app.whenReady = async () => {
      sessionCreated?.(defaultSession);
    };

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });

    assert.equal(registrationCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers Renderer preload and CSP compatibility once per Session", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-session-csp-"));
  try {
    let sessionCreated: ((session: Record<string, unknown>) => void) | undefined;
    let defaultPreloads = 0;
    let defaultCspHooks = 0;
    let laterPreloads = 0;
    let laterCspHooks = 0;
    const defaultSession = fakeSession(
      () => { defaultPreloads += 1; return "claude-plusplus"; },
      () => { defaultCspHooks += 1; },
    );
    const laterSession = fakeSession(
      () => { laterPreloads += 1; return "claude-plusplus-later"; },
      () => { laterCspHooks += 1; },
    );
    const electron = fakeElectron(defaultSession, (listener) => { sessionCreated = listener; });
    electron.app.whenReady = async () => { sessionCreated?.(defaultSession); };

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });
    sessionCreated?.(laterSession);
    sessionCreated?.(laterSession);

    assert.deepEqual(
      { defaultPreloads, defaultCspHooks, laterPreloads, laterCspHooks },
      { defaultPreloads: 1, defaultCspHooks: 1, laterPreloads: 1, laterCspHooks: 1 },
    );
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
    const defaultSession = fakeSession(() => {
      registrationWasEarly = !officialWindowCreated;
      return "claude-plusplus";
    });
    const electron = fakeElectron(defaultSession);
    electron.app.on = ((event: string, listener: () => void) => {
      if (event === "ready") readyListener = listener;
    }) as typeof electron.app.on;
    electron.app.whenReady = async () => {
      readyListener?.();
      officialWindowCreated = true;
    };

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });

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
      fakeSession(() => "default"),
      undefined,
      (listener) => { webContentsCreated = listener; },
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });
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
      fakeSession(() => "default"),
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });
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

test("reload revokes the old Main MCP lease before starting changed source", async (t) => {
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
      permissions: ["ipc", "mcp"],
    }));
    const writeTweak = (version: number) => writeFileSync(
      join(sourceRoot, "index.js"),
      `module.exports = { async start(api) {
        await api.mcp.registerServer({
          name: "claudepp_junction",
          tools: [{
            name: "version",
            description: "Return the fixture version",
            inputSchema: { type: "object", properties: {} },
            handler: async () => ({ content: [{ type: "text", text: "${version}" }] }),
          }],
        });
        api.ipc.handle("version", () => ${version});
      } };\n`,
    );
    writeTweak(1);
    try {
      symlinkSync(sourceRoot, tweakRoot, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("directory link creation is not available");
      return;
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const registryCalls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(registryCalls);
    const electron = fakeElectron(
      fakeSession(() => "default"),
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
      (channel) => handlers.delete(channel),
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    const channel = "claudepp:com.example.junction:version";
    assert.equal(await handlers.get(channel)?.({}), 1);

    writeTweak(2);
    await handlers.get("claudepp:reload-tweaks")?.({});

    assert.equal(await handlers.get(channel)?.({}), 2);
    assert.deepEqual(registryCalls.filter((call) => call !== "install-early"), [
      "register:com.example.junction:claudepp_junction",
      "dispose-mcp:com.example.junction",
      "register:com.example.junction:claudepp_junction",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabling a Main Tweak revokes its Desktop MCP lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-disable-mcp-"));
  try {
    const tweakRoot = join(root, "tweaks", "com.example.disable-mcp");
    mkdirSync(tweakRoot, { recursive: true });
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      ...mainManifest("com.example.disable-mcp"),
      permissions: ["mcp"],
    }));
    writeFileSync(join(tweakRoot, "index.js"), `module.exports = { async start(api) {
      await api.mcp.registerServer({
        name: "claudepp_disable",
        tools: [{
          name: "ping",
          description: "Ping",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        }],
      });
    } };\n`);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const registryCalls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(registryCalls);
    const electron = fakeElectron(
      fakeSession(),
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    await handlers.get("claudepp:set-tweak-enabled")?.({}, "com.example.disable-mcp", false);

    assert.deepEqual(registryCalls, [
      "register:com.example.disable-mcp:claudepp_disable",
      "dispose-mcp:com.example.disable-mcp",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("app quit revokes Main Tweak leases before disposing the shared Desktop service", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-quit-mcp-"));
  try {
    const tweakRoot = join(root, "tweaks", "com.example.quit-mcp");
    mkdirSync(tweakRoot, { recursive: true });
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      ...mainManifest("com.example.quit-mcp"),
      permissions: ["mcp"],
    }));
    writeFileSync(join(tweakRoot, "index.js"), `module.exports = { async start(api) {
      await api.mcp.registerServer({
        name: "claudepp_quit",
        tools: [{
          name: "ping",
          description: "Ping",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        }],
      });
    } };\n`);
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(calls);
    let willQuit: FakeWillQuitListener | undefined;
    const electron = fakeElectron(
      fakeSession(),
      undefined,
      undefined,
      undefined,
      undefined,
      (listener) => { willQuit = listener; },
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    willQuit?.({ preventDefault() {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
      "register:com.example.quit-mcp:claudepp_quit",
      "dispose-mcp:com.example.quit-mcp",
      "dispose-service",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quit waits for idempotent cleanup when readiness is still pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-early-quit-"));
  let resolveReady: (() => void) | undefined;
  let resolveServiceDispose: (() => void) | undefined;
  let bootstrapPromise: Promise<void> | undefined;
  try {
    const tweakRoot = join(root, "tweaks", "com.example.early-quit");
    mkdirSync(tweakRoot, { recursive: true });
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      ...mainManifest("com.example.early-quit"),
      permissions: ["mcp"],
    }));
    writeFileSync(join(tweakRoot, "index.js"), `module.exports = { async start(api) {
      await api.mcp.registerServer({
        name: "claudepp_early_quit",
        tools: [{
          name: "ping",
          description: "Ping",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        }],
      });
    } };\n`);
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const serviceDispose = new Promise<void>((resolve) => { resolveServiceDispose = resolve; });
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(calls, undefined, serviceDispose);
    let willQuit: FakeWillQuitListener | undefined;
    const electron = fakeElectron(
      fakeSession(),
      undefined,
      undefined,
      undefined,
      undefined,
      (listener) => { willQuit = listener; },
    );
    electron.app.whenReady = () => ready;
    electron.app.quit = () => {
      calls.push("quit");
      willQuit?.({ preventDefault: () => calls.push("prevent-reentrant") });
    };

    bootstrapPromise = bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    const firstEvent = { preventDefault: () => calls.push("prevent-first") };
    const duplicateEvent = { preventDefault: () => calls.push("prevent-duplicate") };
    assert.ok(willQuit);
    willQuit(firstEvent);
    willQuit(duplicateEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ["prevent-first", "prevent-duplicate", "dispose-service"]);
    assert.equal(desktopMcpService.disposeCount, 1);

    resolveServiceDispose?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
      "prevent-first",
      "prevent-duplicate",
      "dispose-service",
      "quit",
    ]);
    resolveReady?.();
    await bootstrapPromise;
    assert.deepEqual(desktopMcpService.created, []);
  } finally {
    resolveServiceDispose?.();
    resolveReady?.();
    await bootstrapPromise?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("quit continues later cleanup when shared Desktop service disposal rejects", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-rejected-quit-cleanup-"));
  try {
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(
      calls,
      undefined,
      Promise.resolve(),
      new Error("service disposal failed"),
    );
    let willQuit: FakeWillQuitListener | undefined;
    let managementDisposed = false;
    const electron = fakeElectron(
      fakeSession(),
      undefined,
      undefined,
      undefined,
      () => {
        if (managementDisposed) return;
        managementDisposed = true;
        calls.push("dispose-management");
      },
      (listener) => { willQuit = listener; },
    );
    electron.app.quit = () => { calls.push("quit"); };

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    assert.ok(willQuit);
    willQuit({ preventDefault: () => calls.push("prevent") });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
      "prevent",
      "dispose-service",
      "dispose-management",
      "quit",
    ]);
    assert.equal(desktopMcpService.disposeCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quit drains a pending reload replacement start before disposing the shared service", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-reload-quit-"));
  let resolveReplacementStart: (() => void) | undefined;
  let reloadPromise: Promise<unknown> | undefined;
  try {
    const tweakRoot = join(root, "tweaks", "com.example.reload-quit");
    mkdirSync(tweakRoot, { recursive: true });
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      ...mainManifest("com.example.reload-quit"),
      permissions: ["mcp"],
    }));
    writeFileSync(join(tweakRoot, "index.js"), `module.exports = { async start(api) {
      await api.mcp.registerServer({
        name: "claudepp_reload_quit",
        tools: [{
          name: "ping",
          description: "Ping",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        }],
      });
    } };\n`);
    const replacementStart = new Promise<void>((resolve) => {
      resolveReplacementStart = resolve;
    });
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(
      calls,
      undefined,
      Promise.resolve(),
      undefined,
      [Promise.resolve(), replacementStart],
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let willQuit: FakeWillQuitListener | undefined;
    const electron = fakeElectron(
      fakeSession(),
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
      undefined,
      (listener) => { willQuit = listener; },
    );
    electron.app.quit = () => { calls.push("quit"); };

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    const reload = handlers.get("claudepp:reload-tweaks");
    assert.ok(reload);
    reloadPromise = Promise.resolve(reload({}));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(willQuit);
    willQuit({ preventDefault: () => calls.push("prevent") });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const registration = "register:com.example.reload-quit:claudepp_reload_quit";
    const leaseDisposal = "dispose-mcp:com.example.reload-quit";
    assert.deepEqual(calls, [registration, leaseDisposal, registration, "prevent"]);

    resolveReplacementStart?.();
    await reloadPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
      registration,
      leaseDisposal,
      registration,
      "prevent",
      leaseDisposal,
      "dispose-service",
      "quit",
    ]);
    assert.equal(desktopMcpService.disposeCount, 1);
  } finally {
    resolveReplacementStart?.();
    await reloadPromise?.catch(() => {});
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
      fakeSession(() => "default"),
      undefined,
      undefined,
      (channel, handler) => handlers.set(channel, handler),
    );
    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });
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

test("Safe Mode cold start keeps management IPC but registers no Renderer preload", async () => {
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
    let cspHookCount = 0;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const desktopMcpService = new FakeDesktopMcpService();
    let willQuit: FakeWillQuitListener | undefined;
    let sessionCreated: ((session: Record<string, unknown>) => void) | undefined;
    const electron = fakeElectron(
      fakeSession(
        () => { registrationCount += 1; return "default-safe-mode"; },
        () => { cspHookCount += 1; },
      ),
      (listener) => { sessionCreated = listener; },
      undefined,
      (channel, handler) => handlers.set(channel, handler),
      undefined,
      (listener) => { willQuit = listener; },
    );

    await bootstrapRuntime({
      electron,
      userRoot: root,
      preloadPath: "C:\\runtime\\preload.js",
      startupEnvironment: startupEnvironment(root),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    assert.ok(sessionCreated);
    sessionCreated?.(fakeSession(
      () => { registrationCount += 1; return "late-safe-mode"; },
      () => { cspHookCount += 1; },
    ));
    const payload = await handlers.get("claudepp:list-tweaks")?.({}) as Array<{ enabled: boolean }>;
    willQuit?.({ preventDefault() {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(registrationCount, 0);
    assert.equal(cspHookCount, 0);
    assert.equal(handlers.has("claudepp:list-tweaks"), true);
    assert.deepEqual(payload.map((item) => item.enabled), [false]);
    assert.deepEqual(desktopMcpService.created, []);
    assert.equal(desktopMcpService.disposeCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeSession(
  registerPreloadScript: (options: unknown) => string = () => "claude-plusplus",
  onHeadersReceived: (listener: unknown) => void = () => {},
): Record<string, unknown> {
  return {
    registerPreloadScript,
    webRequest: { onHeadersReceived },
  };
}

function mainManifest(id: string): TweakManifest {
  return {
    id,
    name: id,
    version: "0.2.0",
    githubRepo: "example/runtime-mcp",
    scope: "main",
  };
}

function mcpServer(): TweakMcpServer {
  return {
    name: "claudepp_runtime",
    tools: [{
      name: "ping",
      description: "Ping",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
    }],
  };
}

class FakeDesktopMcpService {
  public readonly created: string[] = [];
  public disposeCount = 0;
  private registrationCount = 0;

  public constructor(
    private readonly calls: string[] = [],
    private readonly installError?: Error,
    private readonly disposeGate: Promise<void> = Promise.resolve(),
    private readonly disposeError?: Error,
    private readonly registrationGates: Promise<void>[] = [],
  ) {}

  public installEarly(): void {
    this.calls.push("install-early");
    if (this.installError) throw this.installError;
  }

  public createMcpApiLease(manifest: Readonly<TweakManifest>) {
    const label = `mcp:${manifest.id}`;
    this.created.push(label);
    let active = true;
    return {
      api: {
        registerServer: async (server: TweakMcpServer) => {
          if (!active) throw new Error("fake MCP lease is disposed");
          this.calls.push(`register:${manifest.id}:${server.name}`);
          const gate = this.registrationGates[this.registrationCount];
          this.registrationCount += 1;
          await gate;
          return {
            unregister: async () => {
              if (!active) throw new Error("fake MCP lease is disposed");
              this.calls.push(`unregister:${manifest.id}:${server.name}`);
            },
          };
        },
      },
      dispose: async () => {
        if (!active) return;
        active = false;
        this.calls.push(`dispose-${label}`);
      },
    };
  }

  public createSessionTitlesApiLease() {
    const label = "titles";
    this.created.push(label);
    let active = true;
    return {
      api: {
        setTitle: async (sessionId: string, title: string) => {
          if (!active) throw new Error("fake title lease is disposed");
          return { sessionId, title };
        },
      },
      dispose: async () => {
        if (!active) return;
        active = false;
        this.calls.push(`dispose-${label}`);
      },
    };
  }

  public async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.calls.push("dispose-service");
    await this.disposeGate;
    if (this.disposeError) throw this.disposeError;
  }
}

interface FakeQuitEvent {
  preventDefault(): void;
}

type FakeWillQuitListener = (event: FakeQuitEvent) => void;

function startupEnvironment(root: string) {
  return initializeStartupEnvironment({
    userRoot: root,
    env: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

function codeSettings(root: string) {
  return initializeClaudeCodeSettings({
    settingsFile: join(root, ".claude", "settings.json"),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

function fakeElectron(
  defaultSession: Record<string, unknown>,
  captureSessionCreated?: (listener: (session: Record<string, unknown>) => void) => void,
  captureWebContentsCreated?: (
    listener: (_event: unknown, webContents: Record<string, unknown>) => void,
  ) => void,
  captureIpcHandle?: (channel: string, handler: (...args: unknown[]) => unknown) => void,
  captureIpcRemoveHandler?: (channel: string) => void,
  captureWillQuit?: (listener: FakeWillQuitListener) => void,
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
        if (event === "will-quit") {
          captureWillQuit?.(listener as unknown as FakeWillQuitListener);
        }
      },
      quit() {},
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
