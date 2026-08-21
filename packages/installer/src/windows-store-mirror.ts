import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeInstall } from "./platform.js";
import type { ClaudePlusPlusPaths } from "./paths.js";

export interface ManagedMirrorResult {
  appRoot: string;
  executablePath: string;
  asarPath: string;
  reused: boolean;
}

export interface MirrorFileSystem {
  rename?(source: string, target: string): Promise<void>;
  remove?(path: string): Promise<void>;
  forceRefresh?: boolean;
}

export interface PreparedManagedMirror {
  mirror: ManagedMirrorResult;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ManagedMirrorMarker {
  packageFullName: string;
  packageVersion: string;
  sourceAppRoot: string;
  createdAt: string;
}

const markerName = ".claude-plusplus-source.json";

export async function cleanupOldWindowsStoreMirrors(
  paths: ClaudePlusPlusPaths,
  currentPackageFullName: string,
): Promise<void> {
  const currentName = currentPackageFullName.toLowerCase();
  const entries = await readdir(paths.storeApps, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.toLowerCase() === currentName) continue;
    const candidate = join(paths.storeApps, entry.name);
    assertImmediateManagedMirrorPath(candidate, paths);
    await rm(candidate, { recursive: true, force: true });
  }
}

export function assertManagedMirrorPath(candidate: string, paths: ClaudePlusPlusPaths): void {
  const root = resolve(paths.storeApps);
  const target = resolve(candidate);
  const child = relative(root, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Path is outside the Claude++ store-apps root: ${candidate}`);
  }
}

function assertImmediateManagedMirrorPath(candidate: string, paths: ClaudePlusPlusPaths): void {
  assertManagedMirrorPath(candidate, paths);
  const root = resolve(paths.storeApps);
  const target = resolve(candidate);
  if (dirname(target).toLowerCase() !== root.toLowerCase()) {
    throw new Error(`Path is not an immediate Claude++ managed mirror: ${candidate}`);
  }
}

export async function ensureWindowsStoreMirror(
  install: ClaudeInstall,
  paths: ClaudePlusPlusPaths,
  fileSystem: MirrorFileSystem = {},
): Promise<ManagedMirrorResult> {
  const prepared = await prepareWindowsStoreMirror(install, paths, fileSystem);
  await prepared.commit();
  return prepared.mirror;
}

export async function prepareWindowsStoreMirror(
  install: ClaudeInstall,
  paths: ClaudePlusPlusPaths,
  fileSystem: MirrorFileSystem = {},
): Promise<PreparedManagedMirror> {
  const target = join(paths.storeApps, install.packageFullName, "app");
  const staging = `${target}.staging-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  for (const path of [target, staging, backup]) assertManagedMirrorPath(path, paths);

  if (!fileSystem.forceRefresh && await isCurrentMirror(target, install)) {
    return settledMirror(resultFor(target, true));
  }

  const renamePath = fileSystem.rename ?? rename;
  const removePath = fileSystem.remove ?? removeRecursively;
  let oldTargetMoved = false;
  let replacementInstalled = false;
  await mkdir(dirname(target), { recursive: true });

  try {
    await cp(install.appRoot, staging, { recursive: true, force: true });
    const marker: ManagedMirrorMarker = {
      packageFullName: install.packageFullName,
      packageVersion: install.packageVersion,
      sourceAppRoot: install.appRoot,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(staging, markerName), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await verifyMirrorFiles(staging);

    if (await pathExists(target)) {
      await renamePath(target, backup);
      oldTargetMoved = true;
    }

    await renamePath(staging, target);
    replacementInstalled = true;
    await verifyMirrorFiles(target);
    return preparedMirror({
      mirror: resultFor(target, false),
      target,
      backup,
      hadPreviousTarget: oldTargetMoved,
      paths,
      renamePath,
      removePath,
    });
  } catch (error) {
    if (replacementInstalled && await pathExists(target)) {
      await guardedRemove(target, paths, removePath);
    }
    if (oldTargetMoved && await pathExists(backup)) {
      await renamePath(backup, target);
    }
    throw error;
  } finally {
    if (await pathExists(staging)) await guardedRemove(staging, paths, removePath);
  }
}

function settledMirror(mirror: ManagedMirrorResult): PreparedManagedMirror {
  return {
    mirror,
    commit: async () => {},
    rollback: async () => {},
  };
}

function preparedMirror(input: {
  mirror: ManagedMirrorResult;
  target: string;
  backup: string;
  hadPreviousTarget: boolean;
  paths: ClaudePlusPlusPaths;
  renamePath(source: string, target: string): Promise<void>;
  removePath(path: string): Promise<void>;
}): PreparedManagedMirror {
  let status: "pending" | "committed" | "rolled-back" = "pending";
  return {
    mirror: input.mirror,
    commit: async () => {
      if (status !== "pending") return;
      status = "committed";
      if (input.hadPreviousTarget) {
        await guardedRemove(input.backup, input.paths, input.removePath);
      }
    },
    rollback: async () => {
      if (status !== "pending") return;
      if (input.hadPreviousTarget && !await pathExists(input.backup)) {
        throw new Error(`Managed mirror backup is missing: ${input.backup}`);
      }
      if (await pathExists(input.target)) {
        await guardedRemove(input.target, input.paths, input.removePath);
      }
      if (input.hadPreviousTarget) {
        await input.renamePath(input.backup, input.target);
      }
      status = "rolled-back";
    },
  };
}

async function isCurrentMirror(target: string, install: ClaudeInstall): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(target, markerName), "utf8")) as Partial<ManagedMirrorMarker>;
    if (marker.packageFullName !== install.packageFullName || marker.packageVersion !== install.packageVersion) {
      return false;
    }
    await verifyMirrorFiles(target);
    return true;
  } catch {
    return false;
  }
}

async function verifyMirrorFiles(appRoot: string): Promise<void> {
  const executable = join(appRoot, "claude.exe");
  const asar = join(appRoot, "resources", "app.asar");
  if (!await pathExists(executable)) throw new Error(`Managed Claude executable is missing: ${executable}`);
  if (!await pathExists(asar)) throw new Error(`Managed Claude app.asar is missing: ${asar}`);
}

function resultFor(appRoot: string, reused: boolean): ManagedMirrorResult {
  return {
    appRoot,
    executablePath: join(appRoot, "claude.exe"),
    asarPath: join(appRoot, "resources", "app.asar"),
    reused,
  };
}

async function guardedRemove(
  path: string,
  paths: ClaudePlusPlusPaths,
  removePath: (path: string) => Promise<void> = removeRecursively,
): Promise<void> {
  assertManagedMirrorPath(path, paths);
  await removePath(path);
}

async function removeRecursively(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
