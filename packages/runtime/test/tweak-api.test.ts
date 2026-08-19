import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ClaudeSessionTitleUpdate,
  TweakLogger,
  TweakManifest,
  TweakMcpRegistration,
  TweakMcpServer,
} from "@claude-plusplus/sdk";
import {
  createMainTweakApiLease,
  createRendererTweakApiLease,
} from "../src/tweak-api.ts";
import { initializeStartupEnvironment } from "../src/startup-environment.ts";
import { initializeClaudeCodeSettings } from "../src/claude-code-settings.ts";
import type { ClaudeSessionTitlesApiLease } from "../src/claude-desktop-mcp-service.ts";
import type { TweakMcpApiLease } from "../src/tweak-mcp-registry.ts";
import { TweakLifecycle } from "../src/tweak-lifecycle.ts";

test("Main API exposes Desktop capabilities only for their exact permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-desktop-api-permissions-"));
  try {
    for (const [permissions, expected] of [
      [[], { mcp: false, titles: false, created: [] }],
      [["mcp"], { mcp: true, titles: false, created: ["mcp:com.example.api"] }],
      [["claude-session-title-write"], {
        mcp: false,
        titles: true,
        created: ["titles"],
      }],
    ] as const) {
      const desktopMcpService = new FakeDesktopMcpService();
      const lease = mainLease(root, permissions, desktopMcpService);

      assert.equal(lease.api.mcp !== undefined, expected.mcp);
      assert.equal(lease.api.claude?.sessionTitles !== undefined, expected.titles);
      assert.deepEqual(desktopMcpService.created, expected.created);
      await lease.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Renderer API never exposes Desktop MCP or session title capabilities", async () => {
  const lease = createRendererTweakApiLease({
    manifest: manifest(["mcp", "claude-session-title-write"]),
    log,
    storage: localStorageBridge(new Map()),
    ipc: rendererIpcBridge(async () => undefined),
  });

  assert.equal(lease.api.mcp, undefined);
  assert.equal(lease.api.claude, undefined);
  await lease.dispose();
});

test("Main API disposal revokes retained Desktop capability references before IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-desktop-api-disposal-"));
  try {
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(calls);
    const lease = createMainTweakApiLease({
      manifest: manifest(["mcp", "claude-session-title-write"]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(calls),
      startupEnvironment: initializeStartupEnvironment({ userRoot: root, env: {}, log }),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    lease.api.ipc.on("ready", () => {});
    const registerServer = lease.api.mcp?.registerServer;
    const setTitle = lease.api.claude?.sessionTitles?.setTitle;
    assert.ok(registerServer);
    assert.ok(setTitle);
    const registration = await registerServer(server());
    const unregister = registration.unregister;

    await lease.dispose();

    await assert.rejects(() => registerServer(server()), /disposed/);
    await assert.rejects(() => unregister(), /disposed/);
    await assert.rejects(() => setTitle("session-1", "Updated"), /disposed/);
    assert.deepEqual(calls, [
      "dispose-mcp:com.example.api",
      "dispose-titles",
      "dispose-ipc",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Main API disposal attempts title, IPC, and storage after Desktop disposer rejections", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-desktop-api-rejected-disposal-"));
  try {
    const calls: string[] = [];
    const desktopMcpService = new FakeDesktopMcpService(calls, {
      mcpDisposeError: new Error("MCP disposal failed"),
      titleDisposeError: new Error("title disposal failed"),
    });
    const lease = createMainTweakApiLease({
      manifest: manifest(["mcp", "claude-session-title-write"]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(calls),
      startupEnvironment: initializeStartupEnvironment({ userRoot: root, env: {}, log }),
      claudeCodeSettings: codeSettings(root),
      desktopMcpService,
    });
    lease.api.ipc.on("ready", () => {});
    lease.api.storage.set("flushed", true);
    let disposalError: unknown;

    try {
      await lease.dispose();
    } catch (error) {
      disposalError = error;
    }

    assert.ok(disposalError instanceof AggregateError);
    assert.deepEqual(
      disposalError.errors.map((error) => error instanceof Error ? error.message : String(error)),
      ["MCP disposal failed", "title disposal failed"],
    );
    assert.deepEqual(calls, [
      "dispose-mcp:com.example.api",
      "dispose-titles",
      "dispose-ipc",
    ]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "storage", "com.example.api.json"), "utf8")),
      { flushed: true },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent Main API disposal shares one in-flight cleanup promise", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-desktop-api-concurrent-disposal-"));
  let resolveMcpDispose: (() => void) | undefined;
  try {
    const calls: string[] = [];
    const mcpDisposeGate = new Promise<void>((resolve) => { resolveMcpDispose = resolve; });
    const desktopMcpService = new FakeDesktopMcpService(calls, { mcpDisposeGate });
    const lease = mainLease(root, ["mcp"], desktopMcpService);

    const first = lease.dispose();
    const second = lease.dispose();

    assert.equal(second, first);
    assert.deepEqual(calls, ["dispose-mcp:com.example.api"]);
    resolveMcpDispose?.();
    await first;
    assert.deepEqual(calls, ["dispose-mcp:com.example.api"]);
  } finally {
    resolveMcpDispose?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Main Desktop capability disposal remains idempotent after Tweak start throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-desktop-api-failed-start-"));
  try {
    const desktopMcpService = new FakeDesktopMcpService();
    const lifecycle = new TweakLifecycle(() => {});
    let failedLease: ReturnType<typeof createMainTweakApiLease> | undefined;

    await lifecycle.startAll([{
      manifest: manifest(["mcp", "claude-session-title-write"]),
      tweak: { start() { throw new Error("boom"); } },
    }], (value) => {
      failedLease = createMainTweakApiLease({
        manifest: value,
        userRoot: root,
        log,
        ipc: mainIpcBridge(),
        startupEnvironment: initializeStartupEnvironment({ userRoot: root, env: {}, log }),
        claudeCodeSettings: codeSettings(root),
        desktopMcpService,
      });
      return failedLease;
    });
    await lifecycle.stopAll();
    await failedLease?.dispose();

    assert.deepEqual(desktopMcpService.disposed, [
      "mcp:com.example.api",
      "titles",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
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
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
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
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
    });
    assert.equal(withoutPermission.api.startupEnvironment, undefined);
    await withoutPermission.dispose();

    const withPermission = createMainTweakApiLease({
      manifest: startupManifest(),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
      claudeCodeSettings: codeSettings(root),
      desktopMcpService: new FakeDesktopMcpService(),
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

test("Main API gates Claude Code settings permission and revokes retained references", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-api-"));
  try {
    const startupEnvironment = initializeStartupEnvironment({ userRoot: root, env: {}, log });
    const service = codeSettings(root);
    const withoutPermission = createMainTweakApiLease({
      manifest: manifest([]),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
      claudeCodeSettings: service,
      desktopMcpService: new FakeDesktopMcpService(),
    });
    assert.equal(withoutPermission.api.claudeCodeSettings, undefined);
    await withoutPermission.dispose();

    const withPermission = createMainTweakApiLease({
      manifest: codeSettingsManifest(),
      userRoot: root,
      log,
      ipc: mainIpcBridge(),
      startupEnvironment,
      claudeCodeSettings: service,
      desktopMcpService: new FakeDesktopMcpService(),
    });
    const retained = withPermission.api.claudeCodeSettings;
    assert.ok(retained);
    const initial = retained.read("skillOverrides.claude-api");
    const written = retained.write("skillOverrides.claude-api", "off", initial.revision);
    assert.equal(written.value, "off");

    await withPermission.dispose();

    assert.throws(() => retained.read("skillOverrides.claude-api"), /disposed/);
    assert.throws(
      () => retained.write("skillOverrides.claude-api", "on", written.revision),
      /disposed/,
    );
    assert.throws(() => retained.remove("skillOverrides.claude-api", written.revision), /disposed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Renderer API never exposes Claude Code settings", async () => {
  const lease = createRendererTweakApiLease({
    manifest: codeSettingsManifest(),
    log,
    storage: localStorageBridge(new Map()),
    ipc: rendererIpcBridge(async () => undefined),
  });

  assert.equal(lease.api.claudeCodeSettings, undefined);
  await lease.dispose();
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

function codeSettingsManifest(): TweakManifest {
  return {
    ...manifest(["claude-code-settings"]),
    claudeCodeSettings: { paths: ["skillOverrides.claude-api"] },
  };
}

function codeSettings(root: string) {
  return initializeClaudeCodeSettings({
    settingsFile: join(root, ".claude", "settings.json"),
    log,
  });
}

function localStorageBridge(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function mainLease(
  root: string,
  permissions: TweakManifest["permissions"],
  desktopMcpService: FakeDesktopMcpService,
) {
  return createMainTweakApiLease({
    manifest: manifest(permissions),
    userRoot: root,
    log,
    ipc: mainIpcBridge(),
    startupEnvironment: initializeStartupEnvironment({ userRoot: root, env: {}, log }),
    claudeCodeSettings: codeSettings(root),
    desktopMcpService,
  });
}

function server(): TweakMcpServer {
  return {
    name: "claudepp_example",
    tools: [{
      name: "echo",
      description: "Echo input",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }],
  };
}

class FakeDesktopMcpService {
  public readonly created: string[] = [];
  public readonly disposed: string[] = [];

  public constructor(
    private readonly calls: string[] = [],
    private readonly disposal: {
      mcpDisposeError?: Error;
      titleDisposeError?: Error;
      mcpDisposeGate?: Promise<void>;
    } = {},
  ) {}

  public createMcpApiLease(manifestValue: Readonly<TweakManifest>): TweakMcpApiLease {
    const label = `mcp:${manifestValue.id}`;
    this.created.push(label);
    let active = true;
    const registrations = new Set<{ active: boolean }>();
    const assertActive = (registration?: { active: boolean }): void => {
      if (!active || registration?.active === false) throw new Error("fake MCP lease is disposed");
    };
    return {
      api: {
        registerServer: async (_server: TweakMcpServer): Promise<TweakMcpRegistration> => {
          assertActive();
          const registration = { active: true };
          registrations.add(registration);
          return {
            unregister: async () => {
              assertActive(registration);
              registration.active = false;
            },
          };
        },
      },
      dispose: async () => {
        if (!active) return;
        active = false;
        for (const registration of registrations) registration.active = false;
        this.disposed.push(label);
        this.calls.push(`dispose-${label}`);
        await this.disposal.mcpDisposeGate;
        if (this.disposal.mcpDisposeError) throw this.disposal.mcpDisposeError;
      },
    };
  }

  public createSessionTitlesApiLease(): ClaudeSessionTitlesApiLease {
    const label = "titles";
    this.created.push(label);
    let active = true;
    return {
      api: {
        setTitle: async (sessionId, title): Promise<ClaudeSessionTitleUpdate> => {
          if (!active) throw new Error("fake session titles lease is disposed");
          return { sessionId, title };
        },
      },
      dispose: async () => {
        if (!active) return;
        active = false;
        this.disposed.push(label);
        this.calls.push(`dispose-${label}`);
        if (this.disposal.titleDisposeError) throw this.disposal.titleDisposeError;
      },
    };
  }
}

function mainIpcBridge(calls: string[] = []) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    on(channel: string, listener: (...args: unknown[]) => void): void {
      listeners.set(channel, listener);
    },
    removeListener(channel: string): void {
      listeners.delete(channel);
      calls.push("dispose-ipc");
    },
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
