import { spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  OFFICIAL_REPO,
  parseReleaseChecksum,
  resolveRelease,
  verifySha256,
  type ReleaseDescriptor,
} from "../release-client.js";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../paths.js";
import {
  writeSelfUpdateState,
  type SelfUpdateChannel,
  type SelfUpdateState,
} from "../state.js";

const version = "0.2.9";

export interface SelfUpdateOptions {
  paths?: ClaudePlusPlusPaths;
  sourceRoot?: string;
  channel?: SelfUpdateChannel;
  repo?: string;
  ref?: string;
  watcher?: boolean;
  force?: boolean;
}

export interface SystemNodeToolchain {
  node: string;
  npm: string;
  version: string;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SelfUpdateDependencies {
  now(): Date;
  resolveRelease(options: { channel: "stable" | "prerelease"; repo: string }): Promise<ReleaseDescriptor>;
  downloadFile(url: string, target: string): Promise<void>;
  extractZip(archive: string, target: string): void;
  extractTar(archive: string, target: string): void;
  findSystemToolchain(): SystemNodeToolchain | null;
  run(command: string, args: string[], cwd: string): CommandResult;
}

export function parseSelfUpdateArguments(argv: string[]): SelfUpdateOptions {
  const options: SelfUpdateOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--prerelease") {
      options.channel = "prerelease";
    } else if (argument === "--repo") {
      options.repo = requireOptionValue(argv, ++index, argument);
      options.channel = "custom";
    } else if (argument === "--ref") {
      options.ref = requireOptionValue(argv, ++index, argument);
      options.channel = "custom";
    } else if (argument === "--watcher") {
      options.watcher = true;
    } else if (argument === "--force") {
      options.force = true;
    } else {
      throw new Error(`Unknown Claude++ update option: ${argument}`);
    }
  }
  return options;
}

interface RuntimeUpdateConfig {
  autoUpdate: boolean;
  updateChannel: SelfUpdateChannel;
  updateRepo: string;
  updateRef: string;
}

interface PreparedUpdate {
  source: string;
  latestVersion: string | null;
  targetRef: string;
  releaseUrl: string | null;
  sourceLabel: string;
}

export async function selfUpdate(
  options: SelfUpdateOptions = {},
  dependencies: Partial<SelfUpdateDependencies> = {},
): Promise<SelfUpdateState> {
  const paths = options.paths ?? resolveClaudePlusPlusPaths();
  const sourceRoot = resolve(options.sourceRoot ?? paths.sourceRoot);
  const config = readUpdateConfig(paths.configFile);
  const selection = resolveSelection(options, config);
  const deps = { ...defaultDependencies, ...dependencies };

  if (options.watcher && !config.autoUpdate) {
    const state = createState({
      status: "disabled",
      now: deps.now(),
      channel: selection.channel,
      repo: selection.repo,
      sourceRoot,
      sourceLabel: selection.sourceLabel,
    });
    writeSelfUpdateState(paths.selfUpdateStateFile, state);
    return state;
  }

  writeSelfUpdateState(paths.selfUpdateStateFile, createState({
    status: "checking",
    now: deps.now(),
    channel: selection.channel,
    repo: selection.repo,
    sourceRoot,
    sourceLabel: selection.sourceLabel,
  }));

  const parent = dirname(sourceRoot);
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, `.${basename(sourceRoot)}-update-`));
  let prepared: PreparedUpdate | null = null;
  try {
    prepared = selection.channel === "custom"
      ? await prepareCustomUpdate(selection.repo, selection.ref, work, deps)
      : await prepareOfficialUpdate(selection.channel, selection.repo, work, deps);

    if (!options.force && prepared.latestVersion && compareVersions(prepared.latestVersion, version) <= 0) {
      const state = createState({
        status: "up-to-date",
        now: deps.now(),
        channel: selection.channel,
        repo: selection.repo,
        sourceRoot,
        sourceLabel: prepared.sourceLabel,
        prepared,
      });
      writeSelfUpdateState(paths.selfUpdateStateFile, state);
      return state;
    }

    applyPreparedUpdate(prepared.source, sourceRoot, paths, deps);
    const state = createState({
      status: "updated",
      now: deps.now(),
      channel: selection.channel,
      repo: selection.repo,
      sourceRoot,
      sourceLabel: prepared.sourceLabel,
      prepared,
    });
    writeSelfUpdateState(paths.selfUpdateStateFile, state);
    return state;
  } catch (error) {
    const state = createState({
      status: "failed",
      now: deps.now(),
      channel: selection.channel,
      repo: selection.repo,
      sourceRoot,
      sourceLabel: prepared?.sourceLabel ?? selection.sourceLabel,
      prepared,
      error: errorMessage(error),
    });
    writeSelfUpdateState(paths.selfUpdateStateFile, state);
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function prepareOfficialUpdate(
  channel: "stable" | "prerelease",
  repo: string,
  work: string,
  deps: SelfUpdateDependencies,
): Promise<PreparedUpdate> {
  const release = await deps.resolveRelease({ channel, repo });
  const archive = join(work, release.archiveName);
  const checksum = `${archive}.sha256`;
  await deps.downloadFile(release.archiveUrl, archive);
  await deps.downloadFile(release.sha256Url, checksum);
  verifySha256(archive, parseReleaseChecksum(readFileSync(checksum, "utf8"), release.archiveName));
  const next = join(work, "next");
  mkdirSync(next, { recursive: true });
  deps.extractZip(archive, next);
  validateReleasePackage(next, release.version);
  return {
    source: next,
    latestVersion: release.version,
    targetRef: release.tag,
    releaseUrl: release.releaseUrl,
    sourceLabel: `${channel === "stable" ? "Stable" : "Prerelease"} ${release.tag}`,
  };
}

async function prepareCustomUpdate(
  repo: string,
  ref: string,
  work: string,
  deps: SelfUpdateDependencies,
): Promise<PreparedUpdate> {
  validateRepo(repo);
  if (!ref.trim()) throw new Error("Custom update ref is required");
  const toolchain = deps.findSystemToolchain();
  if (!toolchain || compareVersions(toolchain.version, "24.0.0") < 0) {
    throw new Error("Node.js 24 or newer and npm are required for the Custom update channel");
  }
  const archive = join(work, "custom-source.tar.gz");
  const customSource = join(work, "custom-source");
  await deps.downloadFile(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`, archive);
  mkdirSync(customSource, { recursive: true });
  deps.extractTar(archive, customSource);
  runCustomBuildStep(deps, toolchain.npm, ["ci", "--workspaces", "--include-workspace-root", "--ignore-scripts"], customSource);
  runCustomBuildStep(deps, toolchain.npm, ["test"], customSource);
  runCustomBuildStep(deps, toolchain.npm, ["run", "package:windows"], customSource);

  const customVersion = readPackageVersion(customSource);
  if (!customVersion) throw new Error("Custom build failed: package.json version is missing");
  const archiveName = `claude-plusplus-${customVersion}-win-x64.zip`;
  const builtArchive = join(customSource, "dist", archiveName);
  const checksum = `${builtArchive}.sha256`;
  if (!existsSync(builtArchive) || !existsSync(checksum)) {
    throw new Error(`Custom build failed: ${archiveName} and its checksum were not produced`);
  }
  verifySha256(builtArchive, parseReleaseChecksum(readFileSync(checksum, "utf8"), archiveName));
  const next = join(work, "next");
  mkdirSync(next, { recursive: true });
  deps.extractZip(builtArchive, next);
  validateReleasePackage(next, customVersion);
  return {
    source: next,
    latestVersion: customVersion,
    targetRef: ref,
    releaseUrl: null,
    sourceLabel: `${repo}@${ref}`,
  };
}

function applyPreparedUpdate(
  preparedSource: string,
  sourceRoot: string,
  paths: ClaudePlusPlusPaths,
  deps: SelfUpdateDependencies,
): void {
  const previousSource = `${sourceRoot}.previous`;
  const work = dirname(preparedSource);
  const runtimeBackup = join(work, "runtime-backup");
  const hadRuntime = existsSync(paths.runtime);
  if (hadRuntime) cpSync(paths.runtime, runtimeBackup, { recursive: true });
  rmSync(previousSource, { recursive: true, force: true });
  let movedCurrent = false;
  try {
    if (existsSync(sourceRoot)) {
      renameSync(sourceRoot, previousSource);
      movedCurrent = true;
    }
    renameSync(preparedSource, sourceRoot);
    const node = join(sourceRoot, "toolchain", "node.exe");
    const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
    const result = deps.run(node, [cli, "install"], sourceRoot);
    if (result.status !== 0) {
      throw new Error(`Claude++ maintenance install failed: ${commandFailure(result)}`);
    }
  } catch (error) {
    rmSync(sourceRoot, { recursive: true, force: true });
    if (movedCurrent && existsSync(previousSource)) renameSync(previousSource, sourceRoot);
    rmSync(paths.runtime, { recursive: true, force: true });
    if (hadRuntime && existsSync(runtimeBackup)) cpSync(runtimeBackup, paths.runtime, { recursive: true });
    throw error;
  }
}

function validateReleasePackage(root: string, expectedVersion: string): void {
  const required = [
    "toolchain/node.exe",
    "packages/installer/dist/cli.js",
    "packages/runtime/dist/main.js",
    "packages/runtime/dist/preload/index.js",
    "packages/loader/loader.cjs",
    "bin/claudeplusplus.cmd",
    "store/index.json",
  ];
  const missing = required.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) throw new Error(`Staged Claude++ package is incomplete: ${missing.join(", ")}`);
  const packageVersion = readPackageVersion(root);
  if (packageVersion !== expectedVersion) {
    throw new Error(`Staged Claude++ package version ${packageVersion ?? "missing"} does not match ${expectedVersion}`);
  }
}

function readPackageVersion(root: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

function runCustomBuildStep(
  deps: SelfUpdateDependencies,
  npm: string,
  args: string[],
  cwd: string,
): void {
  const result = deps.run(npm, args, cwd);
  if (result.status !== 0) throw new Error(`Custom build failed: ${commandFailure(result)}`);
}

function resolveSelection(options: SelfUpdateOptions, config: RuntimeUpdateConfig): {
  channel: SelfUpdateChannel;
  repo: string;
  ref: string;
  sourceLabel: string;
} {
  const custom = options.channel === "custom" || !!options.ref ||
    (!!options.repo && options.repo !== OFFICIAL_REPO);
  const channel = custom ? "custom" : options.channel ?? config.updateChannel;
  const repo = channel === "custom" ? options.repo ?? config.updateRepo : OFFICIAL_REPO;
  const ref = options.ref ?? config.updateRef;
  return {
    channel,
    repo,
    ref,
    sourceLabel: channel === "custom" ? `${repo}@${ref || "(missing ref)"}` : channel,
  };
}

function readUpdateConfig(path: string): RuntimeUpdateConfig {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      claudePlusPlus?: Partial<RuntimeUpdateConfig>;
    };
    const config = value.claudePlusPlus ?? {};
    const channel = config.updateChannel;
    return {
      autoUpdate: config.autoUpdate === true,
      updateChannel: channel === "prerelease" || channel === "custom" ? channel : "stable",
      updateRepo: typeof config.updateRepo === "string" ? config.updateRepo : OFFICIAL_REPO,
      updateRef: typeof config.updateRef === "string" ? config.updateRef : "",
    };
  } catch {
    return {
      autoUpdate: false,
      updateChannel: "stable",
      updateRepo: OFFICIAL_REPO,
      updateRef: "",
    };
  }
}

function createState(options: {
  status: SelfUpdateState["status"];
  now: Date;
  channel: SelfUpdateChannel;
  repo: string;
  sourceRoot: string;
  sourceLabel: string;
  prepared?: PreparedUpdate | null;
  error?: string;
}): SelfUpdateState {
  const checkedAt = options.now.toISOString();
  return {
    checkedAt,
    ...(options.status === "checking" ? {} : { completedAt: checkedAt }),
    status: options.status,
    currentVersion: version,
    latestVersion: options.prepared?.latestVersion ?? null,
    targetRef: options.prepared?.targetRef ?? null,
    releaseUrl: options.prepared?.releaseUrl ?? null,
    repo: options.repo,
    channel: options.channel,
    sourceRoot: options.sourceRoot,
    sourceLabel: options.sourceLabel,
    ...(options.error ? { error: options.error } : {}),
  };
}

function compareVersions(left: string, right: string): number {
  const pattern = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
  const a = pattern.exec(left);
  const b = pattern.exec(right);
  if (!a || !b) return left === right ? 0 : 1;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function validateRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("Custom update repository must use owner/repo format");
  }
}

function commandFailure(result: CommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim();
  return `exit code ${result.status}${output ? `: ${output}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

const defaultDependencies: SelfUpdateDependencies = {
  now: () => new Date(),
  resolveRelease: (options) => resolveRelease(options),
  async downloadFile(url, target) {
    const response = await fetch(url, {
      headers: { "User-Agent": "claude-plusplus-self-update" },
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    await pipeline(response.body, createWriteStream(target));
  },
  extractZip(archive, target) {
    runTar(["-xf", archive, "-C", target]);
  },
  extractTar(archive, target) {
    runTar(["-xzf", archive, "-C", target, "--strip-components=1"]);
  },
  findSystemToolchain,
  run(command, args, cwd) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.cmd$/i.test(command),
    });
    return {
      status: result.status ?? 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? result.error?.message ?? ""),
    };
  },
};

function runTar(args: string[]): void {
  const executable = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Archive extraction failed: ${result.stderr || result.stdout}`);
}

function findSystemToolchain(): SystemNodeToolchain | null {
  if (process.platform !== "win32") return null;
  const node = findOnPath("node.exe").find((candidate) => resolve(candidate) !== resolve(process.execPath));
  const npm = findOnPath("npm.cmd")[0];
  if (!node || !npm) return null;
  const versionResult = spawnSync(node, ["--version"], { encoding: "utf8", windowsHide: true });
  if (versionResult.status !== 0) return null;
  return { node, npm, version: String(versionResult.stdout).trim().replace(/^v/, "") };
}

function findOnPath(name: string): string[] {
  const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  return String(result.stdout).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}
