import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Tweak, TweakLogger } from "@claude-plusplus/sdk";
import { discoverTweaks } from "./tweak-discovery.js";
import { createMainTweakApiLease } from "./tweak-api.js";
import type { MainTweakIpcBridge } from "./tweak-ipc.js";
import { TweakLifecycle, type RunnableTweak } from "./tweak-lifecycle.js";
import { isTweakEnabled, readRuntimeConfig } from "./config.js";
import { installRendererTweakCspCompatibility } from "./renderer-tweak-csp.js";
import { TweakManager } from "./tweak-manager.js";
import { installManagementIpc } from "./management-ipc.js";
import {
  initializeStartupEnvironment,
  type StartupEnvironmentService,
} from "./startup-environment.js";
import {
  initializeClaudeCodeSettings,
  resolveClaudeCodeSettingsFile,
  type ClaudeCodeSettingsService,
} from "./claude-code-settings.js";
import {
  ClaudeDesktopMcpService,
  type ClaudeSessionTitlesApiLease,
} from "./claude-desktop-mcp-service.js";
import type { TweakMcpApiLease } from "./tweak-mcp-registry.js";
import type { TweakUpdateChecker } from "./tweak-update.js";

export type RuntimeDesktopMcpService = Pick<
  ClaudeDesktopMcpService,
  "installEarly" | "createMcpApiLease" | "createSessionTitlesApiLease" | "dispose"
>;

export interface RuntimeBootstrapDeps {
  electron: typeof import("electron");
  userRoot: string;
  preloadPath: string;
  sourceRoot?: string;
  startupEnvironment: StartupEnvironmentService;
  claudeCodeSettings: ClaudeCodeSettingsService;
  desktopMcpService: RuntimeDesktopMcpService;
  tweakUpdateChecker?: TweakUpdateChecker;
}

export interface RuntimeModuleInitializerDeps {
  electron: typeof import("electron");
  userRoot: string;
  runtimeRoot: string;
  startupEnvironment: StartupEnvironmentService;
  claudeCodeSettings: ClaudeCodeSettingsService;
  log?: TweakLogger;
  tweakUpdateChecker?: TweakUpdateChecker;
  createDesktopMcpService?: () => RuntimeDesktopMcpService;
  bootstrap?: (deps: RuntimeBootstrapDeps) => Promise<void>;
}

export function initializeRuntimeModule(deps: RuntimeModuleInitializerDeps): void {
  const logs = join(deps.userRoot, "log");
  mkdirSync(logs, { recursive: true });
  const log = deps.log ?? createLogger(join(logs, "main.log"));
  let desktopMcpService: RuntimeDesktopMcpService | undefined;
  try {
    desktopMcpService = deps.createDesktopMcpService?.() ?? new ClaudeDesktopMcpService({
      desktopVersion: deps.electron.app.getVersion(),
      log,
    });
    desktopMcpService.installEarly();
  } catch (error) {
    log.error(`[Claude++] Desktop MCP observer setup failed: ${errorMessage(error)}`);
    void desktopMcpService?.dispose().catch((disposeError) => {
      log.error(`[Claude++] Desktop MCP setup cleanup failed: ${errorMessage(disposeError)}`);
    });
    desktopMcpService = createUnsupportedDesktopMcpService();
  }

  const bootstrap = deps.bootstrap ?? bootstrapRuntime;
  void bootstrap({
    electron: deps.electron,
    userRoot: deps.userRoot,
    preloadPath: resolve(deps.runtimeRoot, "preload", "index.js"),
    startupEnvironment: deps.startupEnvironment,
    claudeCodeSettings: deps.claudeCodeSettings,
    desktopMcpService,
    tweakUpdateChecker: deps.tweakUpdateChecker,
  }).catch((error) => {
    log.error(`[bootstrap] ${errorMessage(error)}`);
  });
}

export async function bootstrapRuntime(deps: RuntimeBootstrapDeps): Promise<void> {
  const logs = join(deps.userRoot, "log");
  const tweaks = join(deps.userRoot, "tweaks");
  mkdirSync(logs, { recursive: true });
  mkdirSync(tweaks, { recursive: true });
  const log = createLogger(join(logs, "main.log"));
  deps.startupEnvironment.attachAppBridge({
    relaunch: () => deps.electron.app.relaunch(),
    quit: () => deps.electron.app.quit(),
  });
  const config = readRuntimeConfig(join(deps.userRoot, "config.json"));
  const safeMode = config.claudePlusPlus.safeMode;
  if (safeMode) {
    log.warn("Safe Mode is enabled; Tweak loading is disabled");
  }

  installPreloadDiagnostics(deps.electron, log);
  const lifecycle = new TweakLifecycle((message) => log.error(message));
  const ipc = createMainIpcBridge(deps.electron);
  let shutdownRequested = false;
  const startMainTweaks = async (items: RunnableTweak[]): Promise<void> => {
    await lifecycle.startAll(items, (manifest) => createMainTweakApiLease({
      manifest,
      userRoot: deps.userRoot,
      log,
      ipc,
      startupEnvironment: deps.startupEnvironment,
      claudeCodeSettings: deps.claudeCodeSettings,
      desktopMcpService: deps.desktopMcpService,
    }));
  };
  const manager = new TweakManager({
    stopMainTweaks: () => lifecycle.stopAll(),
    clearMainModuleCache: () => clearMainTweakModuleCache(tweaks),
    discoverMainTweaks: () => loadMainTweaks(tweaks, deps.userRoot, log),
    startMainTweaks,
    broadcastRendererReload: (reason) => broadcastRendererReload(deps.electron, reason),
    log: (message) => log.info(message),
  });
  const reload = manager.reload.bind(manager);
  manager.reload = (reason): Promise<void> => {
    if (shutdownRequested) return Promise.resolve();
    return reload(reason);
  };
  const disposeManagementIpc = installManagementIpc({
    electron: deps.electron,
    userRoot: deps.userRoot,
    tweaksRoot: tweaks,
    configFile: join(deps.userRoot, "config.json"),
    sourceRoot: deps.sourceRoot ?? defaultSourceRoot(deps.userRoot),
    log: createLogger(join(logs, "renderer.log")),
    tweakUpdateChecker: deps.tweakUpdateChecker,
    reloadTweaks: (reason) => manager.reload(reason),
  });
  const registeredSessions = new WeakSet<Electron.Session>();
  const register = (session: Electron.Session) => {
    if (registeredSessions.has(session)) return;
    if (safeMode) {
      registeredSessions.add(session);
      return;
    }
    installRendererTweakCspCompatibility(session, log);
    registerPreload(session, deps.preloadPath, log);
    registeredSessions.add(session);
  };
  deps.electron.app.on("session-created", (session) => register(session));
  deps.electron.app.on("ready", () => register(deps.electron.session.defaultSession));
  let stopWatching: () => Promise<void> = async () => {};
  const runQuitCleanupStep = (
    label: string,
    cleanup: () => void | Promise<void>,
  ): void => {
    try {
      const result = cleanup();
      void Promise.resolve(result).catch((error) => {
        log.warn(`${label} failed during quit: ${errorMessage(error)}`);
      });
    } catch (error) {
      log.warn(`${label} failed during quit: ${errorMessage(error)}`);
    }
  };
  deps.electron.app.on("will-quit", () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    runQuitCleanupStep("Main Tweak disposal", () => lifecycle.stopAllForQuit());
    runQuitCleanupStep("Tweak watcher disposal", () => stopWatching());
    runQuitCleanupStep("Desktop MCP service disposal", () => deps.desktopMcpService.dispose());
    runQuitCleanupStep("Management IPC disposal", () => disposeManagementIpc());
  });
  await deps.electron.app.whenReady();
  if (shutdownRequested) return;
  register(deps.electron.session.defaultSession);

  await startMainTweaks(loadMainTweaks(tweaks, deps.userRoot, log));
  if (shutdownRequested) return;
  stopWatching = process.versions.electron
    ? manager.watch(tweaks)
    : async (): Promise<void> => {};
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel);
}

function defaultSourceRoot(userRoot: string): string {
  const profile = process.env.USERPROFILE?.trim();
  return profile ? join(profile, ".claude-plusplus", "source") : join(userRoot, "source");
}

function createMainIpcBridge(electron: typeof import("electron")): MainTweakIpcBridge {
  return {
    on: (channel, listener) => electron.ipcMain.on(channel, listener),
    removeListener: (channel, listener) => electron.ipcMain.removeListener(channel, listener),
    handle: (channel, handler) => electron.ipcMain.handle(channel, handler),
    removeHandler: (channel) => electron.ipcMain.removeHandler(channel),
    getWebContents: () => electron.BrowserWindow?.getAllWindows().map((window) => window.webContents) ?? [],
  } as MainTweakIpcBridge;
}

function installPreloadDiagnostics(electron: typeof import("electron"), log: TweakLogger): void {
  electron.app.on("web-contents-created", (_event, webContents) => {
    const preferences = (webContents as unknown as {
      getLastWebPreferences?: () => Record<string, unknown>;
    }).getLastWebPreferences?.();
    log.info(
      `web-contents-created id=${webContents.id} type=${webContents.getType()} `
      + `sandbox=${String(preferences?.sandbox)} contextIsolation=${String(preferences?.contextIsolation)}`,
    );
    webContents.on("preload-error", (_preloadEvent, path, error) => {
      log.error(
        `preload-error id=${webContents.id} path=${path}: `
        + (error instanceof Error ? error.stack ?? error.message : String(error)),
      );
    });
  });
}

function registerPreload(session: Electron.Session, preloadPath: string, log: TweakLogger): void {
  const modern = session as Electron.Session & {
    registerPreloadScript?: (options: {
      type: "frame";
      id: string;
      filePath: string;
    }) => string;
  };
  if (typeof modern.registerPreloadScript === "function") {
    modern.registerPreloadScript({ type: "frame", id: "claude-plusplus", filePath: preloadPath });
    log.info("Registered Renderer preload through the modern Session API");
    return;
  }
  const existing = session.getPreloads();
  if (!existing.includes(preloadPath)) session.setPreloads([...existing, preloadPath]);
  log.info("Registered Renderer preload through the compatibility path");
}

function loadMainTweaks(
  tweaksRoot: string,
  userRoot: string,
  log: TweakLogger,
): RunnableTweak[] {
  const requireFromRuntime = createRequire(join(process.cwd(), "package.json"));
  const runnable: RunnableTweak[] = [];
  const config = readRuntimeConfig(join(userRoot, "config.json"));
  if (config.claudePlusPlus.safeMode) return runnable;
  for (const item of discoverTweaks(tweaksRoot, "main", (message) => log.warn(message))) {
    if (!isTweakEnabled(config, item.manifest.id)) continue;
    try {
      const loaded = requireFromRuntime(item.entry) as Tweak | { default?: Tweak };
      const tweak = "default" in loaded && loaded.default ? loaded.default : loaded as Tweak;
      if (typeof tweak.start !== "function") throw new Error("entry does not export start(api)");
      runnable.push({ manifest: item.manifest, tweak });
    } catch (error) {
      log.error(`${item.manifest.id} failed to evaluate: ${errorMessage(error)}`);
    }
  }
  return runnable;
}

function clearMainTweakModuleCache(tweaksRoot: string): void {
  const rootSet = new Set<string>([tweaksRoot, safeRealpath(tweaksRoot)]);
  const entrySet = new Set<string>();
  for (const tweak of discoverTweaks(tweaksRoot, "main")) {
    rootSet.add(tweak.dir);
    rootSet.add(safeRealpath(tweak.dir));
    entrySet.add(tweak.entry);
    entrySet.add(safeRealpath(tweak.entry));
  }

  const roots = [...rootSet];
  for (const path of Object.keys(require.cache)) {
    const realPath = safeRealpath(path);
    const isTweakModule =
      entrySet.has(path) ||
      entrySet.has(realPath) ||
      roots.some((root) => isPathInside(root, path) || isPathInside(root, realPath));
    if (isTweakModule) delete require.cache[path];
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function broadcastRendererReload(
  electron: typeof import("electron"),
  reason: string,
): void {
  const contents = electron.webContents?.getAllWebContents?.() ??
    electron.BrowserWindow?.getAllWindows().map((window) => window.webContents) ?? [];
  const payload = { at: Date.now(), reason };
  for (const webContents of contents) {
    try { webContents.send("claudepp:tweaks-changed", payload); } catch {}
  }
}

function createLogger(path: string): TweakLogger {
  const write = (level: string, args: unknown[]) => {
    appendFileSync(
      path,
      `[${new Date().toISOString()}] [${level}] ${formatLogArgs(args)}\n`,
      "utf8",
    );
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

function formatLogArgs(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createUnsupportedDesktopMcpService(): RuntimeDesktopMcpService {
  let disposed = false;
  const unsupported = (): Error => new Error(
    disposed
      ? "Claude Desktop MCP service is disposed"
      : "Claude Desktop MCP service is unsupported",
  );
  return {
    installEarly() {},
    createMcpApiLease(): TweakMcpApiLease {
      let active = true;
      return {
        api: {
          registerServer: async () => {
            if (!active) throw new Error("Claude Desktop MCP API lease is disposed");
            throw unsupported();
          },
        },
        dispose: async () => {
          active = false;
        },
      };
    },
    createSessionTitlesApiLease(): ClaudeSessionTitlesApiLease {
      let active = true;
      return {
        api: {
          setTitle: async () => {
            if (!active) throw new Error("Claude Desktop session titles API lease is disposed");
            throw unsupported();
          },
        },
        dispose: async () => {
          active = false;
        },
      };
    },
    dispose: async () => {
      disposed = true;
    },
  };
}

const userRoot = process.env.CLAUDE_PLUSPLUS_USER_ROOT;
const runtimeRoot = process.env.CLAUDE_PLUSPLUS_RUNTIME;
if (userRoot && runtimeRoot) {
  const logs = join(userRoot, "log");
  mkdirSync(logs, { recursive: true });
  const log = createLogger(join(logs, "main.log"));
  const startupEnvironment = initializeStartupEnvironment({
    userRoot,
    env: process.env,
    log,
  });
  const claudeCodeSettings = initializeClaudeCodeSettings({
    settingsFile: resolveClaudeCodeSettingsFile(),
    log,
  });
  if (process.versions.electron) {
    const electron = require("electron") as typeof import("electron");
    initializeRuntimeModule({
      electron,
      userRoot,
      runtimeRoot,
      startupEnvironment,
      claudeCodeSettings,
      log,
    });
  }
}
