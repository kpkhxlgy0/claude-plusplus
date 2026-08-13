import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateTweakManifest,
  type TweakManifest,
} from "@claude-plusplus/sdk";
import type { ListedTweak } from "./tweak-catalog.js";
import { CLAUDE_PLUSPLUS_VERSION, compareVersions } from "./version.js";

export const DEFAULT_TWEAK_STORE_INDEX_URL =
  "https://kpkhxlgy0.github.io/claude-plusplus/store/index.json";
export const TWEAK_STORE_REVIEW_ISSUE_URL =
  "https://github.com/kpkhxlgy0/claude-plusplus/issues/new";

export type TweakStorePlatform = "darwin" | "win32" | "linux";

export interface TweakStoreRegistry {
  schemaVersion: 1;
  generatedAt?: string;
  entries: TweakStoreEntry[];
}

export interface TweakStoreEntry {
  id: string;
  manifest: TweakManifest;
  repo: string;
  approvedCommitSha: string;
  approvedAt: string;
  approvedBy: string;
  platforms?: TweakStorePlatform[];
  releaseUrl?: string;
  reviewUrl?: string;
}

export interface TweakStoreCompatibility {
  compatible: boolean;
  reason: string | null;
}

export interface TweakStorePlatformCompatibility extends TweakStoreCompatibility {
  current: string;
  supported: TweakStorePlatform[] | null;
}

export interface TweakStoreRuntimeCompatibility extends TweakStoreCompatibility {
  current: string;
  required: string | null;
}

export interface TweakStoreEntryView extends TweakStoreEntry {
  platform: TweakStorePlatformCompatibility;
  runtime: TweakStoreRuntimeCompatibility;
  installed: { version: string; enabled: boolean } | null;
}

export interface TweakStoreRegistryView extends Omit<TweakStoreRegistry, "entries"> {
  sourceUrl: string;
  fetchedAt: string;
  entries: TweakStoreEntryView[];
}

export interface FetchTweakStoreOptions {
  sourceUrl?: string;
  requestJson?: (url: string) => Promise<unknown>;
  installedTweaks?: readonly ListedTweak[];
  platform?: string;
  runtimeVersion?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface TweakStoreArchive {
  download(url: string): Promise<Buffer>;
  list(archiveFile: string): string[];
  extract(archiveFile: string, targetDir: string): void;
}

export interface InstallStoreTweakOptions {
  entry: TweakStoreEntry;
  tweaksRoot: string;
  registryUrl?: string;
  archive?: TweakStoreArchive;
  now?: () => Date;
}

export interface TweakStorePublishSubmission {
  repo: string;
  defaultBranch: string;
  commitSha: string;
  commitUrl: string;
  issueUrl: string;
  manifest?: {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    iconUrl?: string;
  };
}

export interface TweakStoreGitHub {
  getRepository(repo: string): Promise<{ defaultBranch: string }>;
  getCommit(repo: string, ref: string): Promise<{ sha: string; url: string }>;
  getManifest(repo: string, commitSha: string): Promise<Partial<TweakManifest>>;
}

export interface PrepareTweakSubmissionOptions {
  repo: string;
  github?: TweakStoreGitHub;
}

interface StoreInstallMetadata {
  repo: string;
  approvedCommitSha: string;
  installedAt: string;
  storeIndexUrl: string;
  files?: Record<string, string>;
}

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_SHA_RE = /^[a-f0-9]{40}$/i;

export function normalizeGitHubRepo(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("GitHub repo is required");

  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return normalizeRepoPart(ssh[1]);

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname !== "github.com") throw new Error("Only github.com repositories are supported");
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) throw new Error("GitHub repo URL must include owner and repository");
    return normalizeRepoPart(`${parts[0]}/${parts[1]}`);
  }

  return normalizeRepoPart(raw);
}

export function normalizeStoreRegistry(input: unknown): TweakStoreRegistry {
  const registry = input as Partial<TweakStoreRegistry> | null;
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.entries)) {
    throw new Error("Unsupported tweak store registry");
  }
  const entries = registry.entries.map(normalizeStoreEntry);
  entries.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  return {
    schemaVersion: 1,
    ...(typeof registry.generatedAt === "string" ? { generatedAt: registry.generatedAt } : {}),
    entries,
  };
}

export function normalizeStoreEntry(input: unknown): TweakStoreEntry {
  const entry = input as Partial<TweakStoreEntry> | null;
  if (!entry || typeof entry !== "object") throw new Error("Invalid tweak store entry");
  const manifest = entry.manifest as TweakManifest | undefined;
  const repo = normalizeGitHubRepo(String(entry.repo ?? manifest?.githubRepo ?? ""));
  const validation = validateTweakManifest(manifest);
  if (!validation.ok || !manifest) {
    throw new Error(`Store entry for ${repo} has an invalid manifest: ${validation.errors.map((issue) => issue.message).join("; ")}`);
  }
  if (normalizeGitHubRepo(manifest.githubRepo) !== repo) {
    throw new Error(`Store entry ${manifest.id} repo does not match manifest githubRepo`);
  }
  if (!isFullCommitSha(String(entry.approvedCommitSha ?? ""))) {
    throw new Error(`Store entry ${manifest.id} must pin a full approved commit SHA`);
  }
  const platforms = normalizeStorePlatforms(entry.platforms);
  const releaseUrl = optionalGitHubUrl(entry.releaseUrl);
  const reviewUrl = optionalGitHubUrl(entry.reviewUrl);
  return {
    id: manifest.id,
    manifest,
    repo,
    approvedCommitSha: String(entry.approvedCommitSha),
    approvedAt: typeof entry.approvedAt === "string" ? entry.approvedAt : "",
    approvedBy: typeof entry.approvedBy === "string" ? entry.approvedBy : "",
    ...(platforms ? { platforms } : {}),
    ...(releaseUrl ? { releaseUrl } : {}),
    ...(reviewUrl ? { reviewUrl } : {}),
  };
}

export async function fetchTweakStore(options: FetchTweakStoreOptions = {}): Promise<TweakStoreRegistryView> {
  const sourceUrl = options.sourceUrl ?? options.env?.CLAUDE_PLUSPLUS_STORE_URL ??
    process.env.CLAUDE_PLUSPLUS_STORE_URL ?? DEFAULT_TWEAK_STORE_INDEX_URL;
  const registry = normalizeStoreRegistry(await (options.requestJson ?? requestJson)(sourceUrl));
  const installed = new Map((options.installedTweaks ?? []).map((tweak) => [tweak.manifest.id, tweak]));
  const platform = options.platform ?? process.platform;
  const runtimeVersion = options.runtimeVersion ?? CLAUDE_PLUSPLUS_VERSION;
  return {
    ...registry,
    sourceUrl,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    entries: registry.entries.map((entry) => {
      const local = installed.get(entry.id);
      return {
        ...entry,
        platform: storeEntryPlatformCompatibility(entry, platform),
        runtime: storeEntryRuntimeCompatibility(entry, runtimeVersion),
        installed: local ? { version: local.manifest.version, enabled: local.enabled } : null,
      };
    }),
  };
}

export async function installStoreTweak(options: InstallStoreTweakOptions): Promise<void> {
  const { entry, tweaksRoot } = options;
  assertStoreEntryCompatible(entry);
  mkdirSync(tweaksRoot, { recursive: true });
  const work = mkdtempSync(join(tweaksRoot, ".claudepp-store-"));
  const archiveFile = join(work, "source.tar.gz");
  const extractionRoot = join(work, "extract");
  const stagedTarget = join(work, "staged");
  const backupTarget = join(work, "backup");
  const target = join(tweaksRoot, entry.id);
  const archive = options.archive ?? systemArchive;
  let backedUp = false;

  try {
    writeFileSync(archiveFile, await archive.download(storeArchiveUrl(entry)));
    assertSafeArchiveEntries(archive.list(archiveFile));
    mkdirSync(extractionRoot, { recursive: true });
    archive.extract(archiveFile, extractionRoot);
    const source = findSingleTweakRoot(extractionRoot);
    validateStoreTweakSource(entry, source);
    copyTweakSource(source, stagedTarget);
    const metadata: StoreInstallMetadata = {
      repo: entry.repo,
      approvedCommitSha: entry.approvedCommitSha,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
      storeIndexUrl: options.registryUrl ?? DEFAULT_TWEAK_STORE_INDEX_URL,
      files: hashTweakSource(stagedTarget),
    };
    writeFileSync(join(stagedTarget, ".claudepp-store.json"), JSON.stringify(metadata, null, 2));
    assertStoreTweakCleanForUpdate(entry, target);

    if (existsSync(target)) {
      renameSync(target, backupTarget);
      backedUp = true;
    }
    renameSync(stagedTarget, target);
  } catch (error) {
    if (backedUp) {
      rmSync(target, { recursive: true, force: true });
      renameSync(backupTarget, target);
      backedUp = false;
    }
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function prepareTweakSubmission(
  options: PrepareTweakSubmissionOptions,
): Promise<TweakStorePublishSubmission> {
  const repo = normalizeGitHubRepo(options.repo);
  const github = options.github ?? defaultGitHub;
  const repository = await github.getRepository(repo);
  if (!repository.defaultBranch) throw new Error(`Could not resolve default branch for ${repo}`);
  const commit = await github.getCommit(repo, repository.defaultBranch);
  if (!isFullCommitSha(commit.sha)) throw new Error(`Could not resolve a full current commit SHA for ${repo}`);
  const manifest = await github.getManifest(repo, commit.sha).catch(() => undefined);
  const submission: Omit<TweakStorePublishSubmission, "issueUrl"> = {
    repo,
    defaultBranch: repository.defaultBranch,
    commitSha: commit.sha,
    commitUrl: commit.url || `https://github.com/${repo}/commit/${commit.sha}`,
    ...(manifest ? { manifest: submissionManifest(manifest) } : {}),
  };
  return {
    ...submission,
    issueUrl: buildTweakPublishIssueUrl(submission),
  };
}

export function storeArchiveUrl(entry: TweakStoreEntry): string {
  if (!isFullCommitSha(entry.approvedCommitSha)) {
    throw new Error(`Store entry ${entry.id} is not pinned to a full commit SHA`);
  }
  return `https://codeload.github.com/${entry.repo}/tar.gz/${entry.approvedCommitSha}`;
}

export function buildTweakPublishIssueUrl(
  submission: Omit<TweakStorePublishSubmission, "issueUrl">,
): string {
  const repo = normalizeGitHubRepo(submission.repo);
  if (!isFullCommitSha(submission.commitSha)) {
    throw new Error("Submission must include the full commit SHA to review");
  }
  const title = `Tweak store review: ${repo}`;
  const body = [
    "## Tweak repo",
    `https://github.com/${repo}`,
    "",
    "## Commit to review",
    submission.commitSha,
    submission.commitUrl,
    "",
    "Do not approve a different commit. If the author pushes changes, ask them to resubmit.",
    "",
    "## Manifest",
    `- id: ${submission.manifest?.id ?? "(not detected)"}`,
    `- name: ${submission.manifest?.name ?? "(not detected)"}`,
    `- version: ${submission.manifest?.version ?? "(not detected)"}`,
    `- description: ${submission.manifest?.description ?? "(not detected)"}`,
    `- iconUrl: ${submission.manifest?.iconUrl ?? "(not detected)"}`,
    "",
    "## Admin checklist",
    "- [ ] manifest.json is valid",
    "- [ ] manifest.iconUrl is usable as the store icon",
    "- [ ] source was reviewed at the exact commit above",
    "- [ ] `store/index.json` entry pins `approvedCommitSha` to the exact commit above",
  ].join("\n");
  const url = new URL(TWEAK_STORE_REVIEW_ISSUE_URL);
  url.searchParams.set("template", "tweak-store-review.md");
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}

export function assertSafeArchiveEntries(entries: readonly string[]): void {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().replace(/\\/g, "/");
    const segments = entry.split("/");
    if (!entry || entry.startsWith("/") || /^[A-Za-z]:\//.test(entry) || segments.includes("..")) {
      throw new Error(`Archive entry is outside the staging directory: ${rawEntry}`);
    }
  }
}

export function isFullCommitSha(value: string): boolean {
  return FULL_SHA_RE.test(value);
}

function normalizeRepoPart(value: string): string {
  const repo = value.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!GITHUB_REPO_RE.test(repo)) throw new Error("GitHub repo must be in owner/repo form");
  return repo;
}

function normalizeStorePlatforms(input: unknown): TweakStorePlatform[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error("Store entry platforms must be an array");
  const allowed = new Set<TweakStorePlatform>(["darwin", "win32", "linux"]);
  const platforms = Array.from(new Set(input.map((value) => {
    if (typeof value !== "string" || !allowed.has(value as TweakStorePlatform)) {
      throw new Error(`Unsupported store platform: ${String(value)}`);
    }
    return value as TweakStorePlatform;
  })));
  return platforms.length > 0 ? platforms : undefined;
}

function optionalGitHubUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
  return url.toString();
}

function storeEntryPlatformCompatibility(
  entry: TweakStoreEntry,
  platform: string,
): TweakStorePlatformCompatibility {
  const supported = entry.platforms ?? null;
  const compatible = !supported || supported.includes(platform as TweakStorePlatform);
  return {
    current: platform,
    supported,
    compatible,
    reason: compatible ? null : `${entry.manifest.name} is only available on ${formatPlatforms(supported)}.`,
  };
}

function storeEntryRuntimeCompatibility(
  entry: TweakStoreEntry,
  runtimeVersion: string,
): TweakStoreRuntimeCompatibility {
  const required = entry.manifest.minRuntime ?? null;
  const compatible = !required || compareVersions(runtimeVersion, required) >= 0;
  return {
    current: runtimeVersion,
    required,
    compatible,
    reason: compatible || !required
      ? null
      : `${entry.manifest.name} requires Claude++ ${required} or newer.`,
  };
}

function assertStoreEntryCompatible(entry: TweakStoreEntry): void {
  const platform = storeEntryPlatformCompatibility(entry, process.platform);
  if (!platform.compatible) throw new Error(platform.reason ?? `${entry.manifest.name} is unavailable`);
  const runtime = storeEntryRuntimeCompatibility(entry, CLAUDE_PLUSPLUS_VERSION);
  if (!runtime.compatible) throw new Error(runtime.reason ?? `${entry.manifest.name} requires a newer Claude++`);
}

function formatPlatforms(platforms: TweakStorePlatform[] | null): string {
  if (!platforms || platforms.length === 0) return "supported platforms";
  return platforms.map((platform) => {
    if (platform === "darwin") return "macOS";
    if (platform === "win32") return "Windows";
    return "Linux";
  }).join(", ");
}

async function requestJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Store returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

const systemArchive: TweakStoreArchive = {
  async download(url) {
    const response = await fetch(url, {
      headers: { "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}` },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Tweak download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  list(archiveFile) {
    return runTar(["-tzf", archiveFile]).split(/\r?\n/).filter(Boolean);
  },
  extract(archiveFile, targetDir) {
    runTar(["-xzf", archiveFile, "-C", targetDir]);
  },
};

function runTar(args: string[]): string {
  const executable = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function findSingleTweakRoot(root: string): string {
  const found: string[] = [];
  collectTweakRoots(root, found);
  if (found.length === 0) throw new Error("Downloaded archive did not contain manifest.json");
  if (found.length !== 1) throw new Error("Downloaded archive must contain exactly one Tweak root");
  return found[0];
}

function collectTweakRoots(dir: string, found: string[]): void {
  if (!existsSync(dir)) return;
  if (existsSync(join(dir, "manifest.json"))) {
    found.push(dir);
    return;
  }
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (lstatSync(child).isDirectory()) collectTweakRoots(child, found);
  }
}

function validateStoreTweakSource(entry: TweakStoreEntry, source: string): void {
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as TweakManifest;
  const validation = validateTweakManifest(manifest);
  if (!validation.ok) {
    throw new Error(`Downloaded manifest is invalid: ${validation.errors.map((issue) => issue.message).join("; ")}`);
  }
  if (manifest.id !== entry.manifest.id) {
    throw new Error(`Downloaded manifest id ${manifest.id} does not match approved id ${entry.manifest.id}`);
  }
  if (manifest.githubRepo !== entry.repo) {
    throw new Error(`Downloaded manifest repo ${manifest.githubRepo} does not match approved repo ${entry.repo}`);
  }
  if (manifest.version !== entry.manifest.version) {
    throw new Error(`Downloaded manifest version ${manifest.version} does not match approved version ${entry.manifest.version}`);
  }
  const main = resolve(source, manifest.main ?? "index.js");
  if (!isPathInside(source, main) || !existsSync(main) || !statSync(main).isFile()) {
    throw new Error(`Downloaded Tweak entry is missing or outside the Tweak root: ${manifest.main ?? "index.js"}`);
  }
}

function copyTweakSource(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !/(^|[/\\])(?:\.git|node_modules)(?:[/\\]|$)/.test(path),
  });
}

function assertStoreTweakCleanForUpdate(entry: TweakStoreEntry, target: string): void {
  if (!existsSync(target)) return;
  const metadata = readStoreInstallMetadata(target);
  if (!metadata) return;
  if (metadata.repo !== entry.repo || !metadata.files ||
    !sameFileHashes(hashTweakSource(target), metadata.files)) {
    throw new Error(`${entry.manifest.name} is locally modified and cannot be updated automatically.`);
  }
}

function readStoreInstallMetadata(target: string): StoreInstallMetadata | null {
  const file = join(target, ".claudepp-store.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreInstallMetadata>;
    if (typeof parsed.repo !== "string" || typeof parsed.approvedCommitSha !== "string") return null;
    return {
      repo: parsed.repo,
      approvedCommitSha: parsed.approvedCommitSha,
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      storeIndexUrl: typeof parsed.storeIndexUrl === "string" ? parsed.storeIndexUrl : "",
      ...(isHashRecord(parsed.files) ? { files: parsed.files } : {}),
    };
  } catch {
    return null;
  }
}

function hashTweakSource(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  collectTweakFileHashes(root, root, hashes);
  return hashes;
}

function collectTweakFileHashes(root: string, dir: string, hashes: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules" || name === ".claudepp-store.json") continue;
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectTweakFileHashes(root, fullPath, hashes);
    } else if (stat.isFile()) {
      hashes[relative(root, fullPath).split(sep).join("/")] = createHash("sha256")
        .update(readFileSync(fullPath))
        .digest("hex");
    }
  }
}

function sameFileHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && left[key] === right[key]);
}

function isHashRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash));
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function submissionManifest(manifest: Partial<TweakManifest>): TweakStorePublishSubmission["manifest"] {
  return {
    ...(typeof manifest.id === "string" ? { id: manifest.id } : {}),
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    ...(typeof manifest.iconUrl === "string" ? { iconUrl: manifest.iconUrl } : {}),
  };
}

const defaultGitHub: TweakStoreGitHub = {
  async getRepository(repo) {
    const value = await requestGitHubJson<{ default_branch?: string }>(`https://api.github.com/repos/${repo}`);
    return { defaultBranch: value.default_branch ?? "" };
  },
  async getCommit(repo, ref) {
    const value = await requestGitHubJson<{ sha?: string; html_url?: string }>(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    );
    return { sha: value.sha ?? "", url: value.html_url ?? "" };
  },
  async getManifest(repo, commitSha) {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${commitSha}/manifest.json`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}`,
      },
    });
    if (!response.ok) throw new Error(`Manifest fetch returned ${response.status}`);
    return await response.json() as Partial<TweakManifest>;
  },
};

async function requestGitHubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}
