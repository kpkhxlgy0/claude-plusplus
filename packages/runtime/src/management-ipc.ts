import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { TweakLogger } from "@claude-plusplus/sdk";
import {
  mutateRuntimeConfig,
  readRuntimeConfig,
  setTweakEnabled,
  type UpdateChannel,
} from "./config.js";
import { discoverTweaks } from "./tweak-discovery.js";
import { createTweakFs } from "./tweak-fs.js";
import { listInstalledTweaks } from "./tweak-catalog.js";
import {
  fetchTweakStore,
  installStoreTweak,
  normalizeGitHubRepo,
  prepareTweakSubmission,
} from "./tweak-store.js";
import {
  checkClaudePlusPlusUpdate,
  getUpdateConfigView,
  runClaudePlusPlusUpdate,
} from "./update-service.js";
import { getWatcherHealth } from "./watcher-health.js";

export interface ManagementIpcDeps {
  electron: typeof import("electron");
  userRoot: string;
  tweaksRoot: string;
  configFile: string;
  sourceRoot: string;
  log: TweakLogger;
  reloadTweaks(reason: string): Promise<void>;
}

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export function installManagementIpc(deps: ManagementIpcDeps): () => void {
  const channels: string[] = [];
  const selfUpdateStateFile = join(deps.userRoot, "self-update.json");
  const updatePaths = {
    sourceRoot: deps.sourceRoot,
    configFile: deps.configFile,
    selfUpdateStateFile,
  };
  const listTweaks = () => listInstalledTweaks({
    tweaksRoot: deps.tweaksRoot,
    config: readRuntimeConfig(deps.configFile),
    onIssue: (message) => deps.log.warn(message),
  });
  const register = (channel: string, handler: IpcHandler): void => {
    deps.electron.ipcMain.handle(channel, handler);
    channels.push(channel);
  };

  register("claudepp:list-tweaks", () => listTweaks());
  register("claudepp:user-paths", () => ({
    userRoot: deps.userRoot,
    runtimeDir: process.env.CLAUDE_PLUSPLUS_RUNTIME ?? "",
    tweaksDir: deps.tweaksRoot,
    logDir: join(deps.userRoot, "log"),
  }));
  register("claudepp:read-tweak-source", (_event, entryPath) => {
    const entry = validatedChildPath(deps.tweaksRoot, entryPath, "Tweak source");
    return readFileSync(entry, "utf8");
  });
  register("claudepp:read-tweak-asset", (_event, tweakDir, relPath) => {
    const dir = validatedChildPath(deps.tweaksRoot, tweakDir, "Tweak directory");
    const asset = validatedChildPath(dir, relPath, "Tweak asset");
    const size = statSync(asset).size;
    if (size > 1024 * 1024) throw new Error("Tweak asset is larger than 1 MiB");
    return `data:${mimeType(extname(asset))};base64,${readFileSync(asset).toString("base64")}`;
  });
  register("claudepp:set-tweak-enabled", async (_event, id, enabled) => {
    const tweakId = requireInstalledTweakId(id, listTweaks());
    if (typeof enabled !== "boolean") throw new Error("Tweak enabled-state request is invalid");
    setTweakEnabled(deps.configFile, tweakId, enabled);
    await deps.reloadTweaks("enabled-toggle");
    return { id: tweakId, enabled };
  });
  register("claudepp:reload-tweaks", async () => {
    await deps.reloadTweaks("manual");
    return { at: Date.now() };
  });
  register("claudepp:reveal", async (_event, path) => {
    if (typeof path !== "string") throw new Error("Reveal path is invalid");
    await deps.electron.shell.openPath(path);
    return true;
  });
  register("claudepp:open-external", async (_event, url) => {
    const parsed = requireGitHubUrl(url);
    await deps.electron.shell.openExternal(parsed);
    return true;
  });
  register("claudepp:copy-text", (_event, value) => {
    if (typeof value !== "string") throw new Error("Clipboard text is invalid");
    deps.electron.clipboard.writeText(value);
    return true;
  });
  register("claudepp:renderer-log", (_event, level, message) => {
    const normalized = level === "debug" || level === "warn" || level === "error" ? level : "info";
    deps.log[normalized](String(message));
    return true;
  });
  register("claudepp:tweak-fs", async (_event, id, operation, relPath, contents) => {
    if (typeof operation !== "string" || typeof relPath !== "string" ||
      !["read", "write", "exists"].includes(operation)) {
      throw new Error("Tweak filesystem request is invalid");
    }
    const tweakId = requireTweakId(id);
    const item = discoverTweaks(deps.tweaksRoot, "renderer").find((candidate) =>
      candidate.manifest.id === tweakId);
    if (!item?.manifest.permissions?.includes("filesystem")) {
      throw new Error("Tweak requires filesystem permission");
    }
    const fs = createTweakFs(deps.userRoot, tweakId);
    if (operation === "read") return await fs.read(relPath);
    if (operation === "exists") return await fs.exists(relPath);
    if (typeof contents !== "string") throw new Error("Tweak filesystem request is invalid");
    await fs.write(relPath, contents);
    return undefined;
  });

  register("claudepp:get-config", () => getUpdateConfigView(updatePaths));
  register("claudepp:set-auto-update", (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Automatic update setting is invalid");
    if (enabled && !getWatcherHealth(deps.userRoot).installed) {
      throw new Error("Enable the Claude++ Watcher before automatic refresh");
    }
    mutateRuntimeConfig(deps.configFile, (config) => {
      config.claudePlusPlus.autoUpdate = enabled;
    });
    return { autoUpdate: enabled };
  });
  register("claudepp:set-update-config", (_event, input) => {
    const update = normalizeUpdateConfig(input);
    const config = mutateRuntimeConfig(deps.configFile, (next) => {
      if (update.updateChannel) next.claudePlusPlus.updateChannel = update.updateChannel;
      if (update.updateRepo !== undefined) next.claudePlusPlus.updateRepo = update.updateRepo;
      if (update.updateRef !== undefined) next.claudePlusPlus.updateRef = update.updateRef;
    });
    return {
      updateChannel: config.claudePlusPlus.updateChannel,
      updateRepo: config.claudePlusPlus.updateRepo,
      updateRef: config.claudePlusPlus.updateRef,
    };
  });
  register("claudepp:check-claudepp-update", (_event, force) => {
    if (force !== undefined && typeof force !== "boolean") throw new Error("Update check request is invalid");
    return checkClaudePlusPlusUpdate({ ...updatePaths, force: force === true });
  });
  register("claudepp:run-claudepp-update", () => runClaudePlusPlusUpdate(updatePaths));
  register("claudepp:get-watcher-health", () => getWatcherHealth(deps.userRoot));
  register("claudepp:set-watcher-enabled", async (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Watcher setting is invalid");
    await runInstallerCommand(deps.sourceRoot, ["watcher", enabled ? "enable" : "disable"]);
    if (!enabled) {
      mutateRuntimeConfig(deps.configFile, (config) => {
        config.claudePlusPlus.autoUpdate = false;
      });
    }
    return getWatcherHealth(deps.userRoot);
  });

  register("claudepp:get-tweak-store", () => fetchTweakStore({ installedTweaks: listTweaks() }));
  register("claudepp:install-store-tweak", async (_event, id) => {
    const tweakId = requireTweakId(id);
    const store = await fetchTweakStore({ installedTweaks: listTweaks() });
    const entry = store.entries.find((candidate) => candidate.id === tweakId);
    if (!entry) throw new Error(`Tweak store entry not found: ${tweakId}`);
    await installStoreTweak({ entry, tweaksRoot: deps.tweaksRoot, registryUrl: store.sourceUrl });
    await deps.reloadTweaks("store-install");
    return { installed: tweakId };
  });
  register("claudepp:prepare-tweak-submission", (_event, repo) => {
    if (typeof repo !== "string") throw new Error("Tweak repository is invalid");
    return prepareTweakSubmission({ repo });
  });

  return () => {
    for (const channel of channels) deps.electron.ipcMain.removeHandler(channel);
  };
}

function validatedChildPath(root: string, value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} path is invalid`);
  const candidate = resolve(root, value);
  if (!isPathInside(root, candidate)) throw new Error(`${label} path is outside its allowed directory`);
  return candidate;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel);
}

function requireTweakId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error("Tweak ID is invalid");
  }
  return value;
}

function requireInstalledTweakId(
  value: unknown,
  installed: ReturnType<typeof listInstalledTweaks>,
): string {
  const id = requireTweakId(value);
  if (!installed.some((item) => item.manifest.id === id)) throw new Error(`Tweak is not installed: ${id}`);
  return id;
}

function requireGitHubUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("External URL is invalid");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("Only github.com links can be opened from Tweak metadata");
  }
  return parsed.toString();
}

function normalizeUpdateConfig(value: unknown): {
  updateChannel?: UpdateChannel;
  updateRepo?: string;
  updateRef?: string;
} {
  if (!isRecord(value)) throw new Error("Update configuration is invalid");
  const output: { updateChannel?: UpdateChannel; updateRepo?: string; updateRef?: string } = {};
  if (value.updateChannel !== undefined) {
    if (value.updateChannel !== "stable" && value.updateChannel !== "prerelease" &&
      value.updateChannel !== "custom") throw new Error("Update channel is invalid");
    output.updateChannel = value.updateChannel;
  }
  if (value.updateRepo !== undefined) {
    if (typeof value.updateRepo !== "string") throw new Error("Update repository is invalid");
    output.updateRepo = normalizeGitHubRepo(value.updateRepo);
  }
  if (value.updateRef !== undefined) {
    if (typeof value.updateRef !== "string") throw new Error("Update ref is invalid");
    output.updateRef = value.updateRef.trim();
  }
  return output;
}

function runInstallerCommand(sourceRoot: string, args: string[]): Promise<void> {
  const node = join(sourceRoot, "toolchain", "node.exe");
  const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
  if (!existsSync(node) || !existsSync(cli)) {
    throw new Error("Claude++ installed CLI is unavailable. Run the installer again, then retry.");
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(node, [cli, ...args], {
      cwd: sourceRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Claude++ Installer exited with code ${String(code)}`));
    });
  });
}

function mimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
