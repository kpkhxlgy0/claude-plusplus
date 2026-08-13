import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  mutateRuntimeConfig,
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
  selfUpdateStateFile: string;
}

export interface GitHubReleaseView {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface CheckClaudePlusPlusUpdateOptions extends UpdateServicePaths {
  force?: boolean;
  now?: () => Date;
  requestReleases?: (repo: string) => Promise<GitHubReleaseView[]>;
}

export interface RunClaudePlusPlusUpdateOptions extends UpdateServicePaths {
  launch?: (command: string, args: string[]) => void;
  now?: () => Date;
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function getUpdateConfigView(paths: UpdateServicePaths): ClaudePlusPlusConfigView {
  const config = readRuntimeConfig(paths.configFile);
  return {
    version: CLAUDE_PLUSPLUS_VERSION,
    autoUpdate: config.claudePlusPlus.autoUpdate,
    updateChannel: config.claudePlusPlus.updateChannel,
    updateRepo: config.claudePlusPlus.updateRepo,
    updateRef: config.claudePlusPlus.updateRef,
    installationSource: describeInstallationSource(paths.sourceRoot),
    updateCheck: config.claudePlusPlus.updateCheck ?? null,
    selfUpdate: readSelfUpdateState(paths.selfUpdateStateFile),
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
    const releases = await (options.requestReleases ?? requestReleases)(repo);
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
  mutateRuntimeConfig(options.configFile, (next) => {
    next.claudePlusPlus.updateCheck = check;
  });
  return check;
}

export function runClaudePlusPlusUpdate(
  options: RunClaudePlusPlusUpdateOptions,
): { status: "checking" } {
  const config = readRuntimeConfig(options.configFile);
  const node = join(options.sourceRoot, "toolchain", "node.exe");
  const cli = join(options.sourceRoot, "packages", "installer", "dist", "cli.js");
  if (!existsSync(node) || !existsSync(cli)) {
    throw new Error("Claude++ installed CLI is unavailable. Run the installer again, then retry.");
  }
  const args = [cli, "update"];
  if (config.claudePlusPlus.updateChannel === "prerelease") args.push("--prerelease");
  if (config.claudePlusPlus.updateChannel === "custom") {
    args.push("--repo", config.claudePlusPlus.updateRepo, "--ref", config.claudePlusPlus.updateRef);
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const repo = config.claudePlusPlus.updateChannel === "custom"
    ? config.claudePlusPlus.updateRepo
    : CLAUDE_PLUSPLUS_REPO;
  writeJsonAtomic(options.selfUpdateStateFile, {
    checkedAt: now,
    status: "checking",
    currentVersion: CLAUDE_PLUSPLUS_VERSION,
    latestVersion: null,
    targetRef: config.claudePlusPlus.updateChannel === "custom" ? config.claudePlusPlus.updateRef : null,
    releaseUrl: null,
    repo,
    channel: config.claudePlusPlus.updateChannel,
    sourceRoot: options.sourceRoot,
    sourceLabel: describeInstallationSource(options.sourceRoot).label,
  });
  (options.launch ?? launchDetached)(node, args);
  return { status: "checking" };
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

async function requestReleases(repo: string): Promise<GitHubReleaseView[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json() as GitHubReleaseView[];
  } finally {
    clearTimeout(timeout);
  }
}

function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    cwd: dirname(command),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
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
