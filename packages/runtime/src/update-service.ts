import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  mutateRuntimeConfigAdvisory,
  readRuntimeConfig,
  type ClaudePlusPlusUpdateCheck,
  type UpdateChannel,
} from "./config.js";
import { CLAUDE_PLUSPLUS_VERSION, compareVersions } from "./version.js";

export const CLAUDE_PLUSPLUS_REPO = "kpkhxlgy0/claude-plusplus";

export interface SelfUpdateStateView {
  checkedAt: string;
  completedAt?: string;
  status: "checking" | "up-to-date" | "updated" | "failed" | "disabled";
  currentVersion: string;
  latestVersion: string | null;
  targetRef: string | null;
  releaseUrl: string | null;
  repo: string;
  channel: UpdateChannel;
  sourceRoot: string;
  sourceLabel: string;
  processId?: number;
  error?: string;
}

export interface ClaudePlusPlusConfigView {
  version: string;
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  updateRepo: string;
  updateRef: string;
  installationSource: { label: string; detail: string };
  updateCheck: ClaudePlusPlusUpdateCheck | null;
  selfUpdate: SelfUpdateStateView | null;
}

export interface UpdateServicePaths {
  sourceRoot: string;
  configFile: string;
  stateFile: string;
  selfUpdateStateFile: string;
}

export interface GitHubReleaseView {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface ProductUpdateTimer {
  set(callback: () => void, delay: number): ProductUpdateTimerHandle;
  clear(handle: ProductUpdateTimerHandle): void;
}

export type ProductUpdateTimerHandle = object;

const defaultProductUpdateTimer: ProductUpdateTimer = {
  set: (callback, delay) => setTimeout(callback, delay) as ProductUpdateTimerHandle,
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CheckClaudePlusPlusUpdateOptions extends UpdateServicePaths {
  force?: boolean;
  now?: () => Date;
  requestReleases?: (repo: string) => Promise<GitHubReleaseView[]>;
  request?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timer?: ProductUpdateTimer;
  persist?: typeof mutateRuntimeConfigAdvisory;
  onIssue?: (message: string) => void;
}

export interface RunClaudePlusPlusUpdateOptions extends UpdateServicePaths {
  launch?: (command: string, args: string[]) => number | void | Promise<number | void>;
  now?: () => Date;
  probeNodeVersion?: (path: string) => string | null;
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SELF_UPDATE_LAUNCH_GRACE_MS = 60 * 1000;
const SELF_UPDATE_MAX_ACTIVE_MS = 6 * 60 * 60 * 1000;

export function getUpdateConfigView(paths: UpdateServicePaths): ClaudePlusPlusConfigView {
  const config = readRuntimeConfig(paths.configFile);
  const selfUpdate = readSelfUpdateState(paths.selfUpdateStateFile);
  return {
    version: CLAUDE_PLUSPLUS_VERSION,
    autoUpdate: config.claudePlusPlus.autoUpdate,
    updateChannel: config.claudePlusPlus.updateChannel,
    updateRepo: config.claudePlusPlus.updateRepo,
    updateRef: config.claudePlusPlus.updateRef,
    installationSource: describeInstallationSource(paths.sourceRoot),
    updateCheck: config.claudePlusPlus.updateCheck ?? null,
    selfUpdate: retryableSelfUpdateView(selfUpdate),
  };
}

export async function checkClaudePlusPlusUpdate(
  options: CheckClaudePlusPlusUpdateOptions,
): Promise<ClaudePlusPlusUpdateCheck> {
  const config = readRuntimeConfig(options.configFile);
  const cached = config.claudePlusPlus.updateCheck;
  const now = options.now ?? (() => new Date());
  if (!options.force && cached && cached.currentVersion === CLAUDE_PLUSPLUS_VERSION &&
    now().getTime() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS) return cached;

  const repo = config.claudePlusPlus.updateChannel === "custom"
    ? config.claudePlusPlus.updateRepo
    : CLAUDE_PLUSPLUS_REPO;
  const includePrerelease = config.claudePlusPlus.updateChannel === "prerelease";
  let check: ClaudePlusPlusUpdateCheck;
  try {
    const loadReleases = options.requestReleases ??
      ((repo: string) => requestReleases(
        repo,
        options.request ?? fetch,
        options.timer ?? defaultProductUpdateTimer,
      ));
    const releases = await loadReleases(repo);
    const release = releases.find((candidate) => !candidate.draft &&
      (includePrerelease || !candidate.prerelease));
    const latestVersion = normalizeVersion(release?.tag_name);
    check = {
      checkedAt: now().toISOString(),
      currentVersion: CLAUDE_PLUSPLUS_VERSION,
      latestVersion,
      releaseUrl: release?.html_url ?? `https://github.com/${repo}/releases`,
      releaseNotes: typeof release?.body === "string" ? release.body : null,
      updateAvailable: latestVersion ? compareVersions(latestVersion, CLAUDE_PLUSPLUS_VERSION) > 0 : false,
      ...(!release ? { error: "no GitHub release found" } : {}),
    };
  } catch (error) {
    check = {
      checkedAt: now().toISOString(),
      currentVersion: CLAUDE_PLUSPLUS_VERSION,
      latestVersion: null,
      releaseUrl: `https://github.com/${repo}/releases`,
      releaseNotes: null,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const persistence = (options.persist ?? mutateRuntimeConfigAdvisory)(
    options.configFile,
    (config) => { config.claudePlusPlus.updateCheck = check; },
  );
  if (persistence.status !== "persisted") {
    options.onIssue?.(`Claude++ update cache ${persistence.status}`);
  }
  return check;
}

export async function runClaudePlusPlusUpdate(
  options: RunClaudePlusPlusUpdateOptions,
): Promise<{ status: "checking" }> {
  const now = options.now ?? (() => new Date());
  if (isSelfUpdateActive(readSelfUpdateState(options.selfUpdateStateFile), now().getTime())) {
    return { status: "checking" };
  }
  const config = readRuntimeConfig(options.configFile);
  const cli = join(options.sourceRoot, "packages", "installer", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("Claude++ installed CLI is unavailable. Run the installer again, then retry.");
  }
  const node = resolveUpdateNodeRuntime(options);
  const args = [cli, "update"];
  if (config.claudePlusPlus.updateChannel === "prerelease") args.push("--prerelease");
  if (config.claudePlusPlus.updateChannel === "custom") {
    args.push("--repo", config.claudePlusPlus.updateRepo, "--ref", config.claudePlusPlus.updateRef);
  }
  const repo = config.claudePlusPlus.updateChannel === "custom"
    ? config.claudePlusPlus.updateRepo
    : CLAUDE_PLUSPLUS_REPO;
  const checkingState: SelfUpdateStateView = {
    checkedAt: now().toISOString(),
    status: "checking",
    currentVersion: CLAUDE_PLUSPLUS_VERSION,
    latestVersion: null,
    targetRef: config.claudePlusPlus.updateChannel === "custom" ? config.claudePlusPlus.updateRef : null,
    releaseUrl: null,
    repo,
    channel: config.claudePlusPlus.updateChannel,
    sourceRoot: options.sourceRoot,
    sourceLabel: describeInstallationSource(options.sourceRoot).label,
  };
  writeJsonAtomic(options.selfUpdateStateFile, checkingState);
  try {
    const processId = await (options.launch ?? launchDetached)(node, args);
    if (typeof processId === "number" && Number.isSafeInteger(processId) && processId > 0) {
      recordLaunchedProcessId(options.selfUpdateStateFile, checkingState.checkedAt, processId);
    }
  } catch (error) {
    const message = `Could not start Claude++ updater: ${errorMessage(error)}`;
    writeJsonAtomic(options.selfUpdateStateFile, {
      ...checkingState,
      completedAt: now().toISOString(),
      status: "failed",
      error: message,
    });
    throw new Error(message);
  }
  return { status: "checking" };
}

function recordLaunchedProcessId(path: string, checkedAt: string, processId: number): void {
  const current = readSelfUpdateState(path);
  if (current?.status !== "checking" || current.checkedAt !== checkedAt) return;
  writeJsonAtomic(path, { ...current, processId });
}

function retryableSelfUpdateView(state: SelfUpdateStateView | null): SelfUpdateStateView | null {
  if (state?.status !== "checking" || isSelfUpdateActive(state)) return state;
  return {
    ...state,
    completedAt: state.checkedAt,
    status: "failed",
    error: "The previous Claude++ update did not complete. Retry the update.",
  };
}

function isSelfUpdateActive(
  state: SelfUpdateStateView | null,
  now = Date.now(),
): boolean {
  if (state?.status !== "checking") return false;
  const checkedAt = Date.parse(state.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  const age = now - checkedAt;
  if (age > SELF_UPDATE_MAX_ACTIVE_MS) return false;
  if (typeof state.processId === "number" && Number.isSafeInteger(state.processId) && state.processId > 0) {
    return isProcessRunning(state.processId);
  }
  return age >= -SELF_UPDATE_LAUNCH_GRACE_MS && age <= SELF_UPDATE_LAUNCH_GRACE_MS;
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function resolveUpdateNodeRuntime(options: RunClaudePlusPlusUpdateOptions): string {
  const bundledNode = join(options.sourceRoot, "toolchain", "node.exe");
  if (existsSync(bundledNode)) return bundledNode;

  const recordedNode = readRecordedNodeRuntimePath(options.stateFile);
  if (!recordedNode || !isAbsolute(recordedNode) || !existsSync(recordedNode)) {
    throw new Error(
      "Claude++ needs Node.js 24 or newer to update this source installation. " +
      "Re-run install.ps1 with Node.js 24 or newer, then retry.",
    );
  }
  const version = (options.probeNodeVersion ?? probeNodeVersion)(recordedNode);
  const major = version?.trim().match(/^v(\d+)\.\d+\.\d+$/)?.[1];
  if (!major || Number(major) < 24) {
    throw new Error(
      `Claude++ needs Node.js 24 or newer to update this source installation ` +
      `(recorded runtime reported ${version?.trim() || "no valid version"}). ` +
      "Re-run install.ps1 with Node.js 24 or newer, then retry.",
    );
  }
  return recordedNode;
}

function readRecordedNodeRuntimePath(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return null;
    return typeof value.nodeRuntimePath === "string" ? value.nodeRuntimePath : null;
  } catch {
    return null;
  }
}

function probeNodeVersion(path: string): string | null {
  try {
    return execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function describeInstallationSource(sourceRoot: string): { label: string; detail: string } {
  if (existsSync(join(sourceRoot, "toolchain", "node.exe"))) {
    return { label: "Packaged Windows release", detail: "Bundled Node.js runtime" };
  }
  return { label: "Source checkout", detail: "Local or Custom source build" };
}

function readSelfUpdateState(path: string): SelfUpdateStateView | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SelfUpdateStateView>;
    if (typeof value.checkedAt !== "string" || typeof value.status !== "string" ||
      typeof value.currentVersion !== "string" || typeof value.repo !== "string" ||
      typeof value.channel !== "string" || typeof value.sourceRoot !== "string") return null;
    return value as SelfUpdateStateView;
  } catch {
    return null;
  }
}

function normalizeVersion(tag: unknown): string | null {
  if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag)) return null;
  return tag.replace(/^v/, "");
}

async function requestReleases(
  repo: string,
  request = fetch,
  timer: ProductUpdateTimer = defaultProductUpdateTimer,
): Promise<GitHubReleaseView[]> {
  const controller = new AbortController();
  const timeout = timer.set(() => controller.abort(), 8_000);
  try {
    const response = await request(
      `https://api.github.com/repos/${repo}/releases?per_page=20`,
      {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}`,
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json() as GitHubReleaseView[];
  } finally {
    timer.clear(timeout);
  }
}

function launchDetached(command: string, args: string[]): Promise<number | void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: dirname(command),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
