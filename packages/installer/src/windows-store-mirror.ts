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
  const target = join(paths.storeApps, install.packageFullName, "app");
  const staging = `${target}.staging-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  for (const path of [target, staging, backup]) assertManagedMirrorPath(path, paths);

  if (await isCurrentMirror(target, install)) return resultFor(target, true);

  const renamePath = fileSystem.rename ?? rename;
  let oldTargetMoved = false;
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
    await verifyMirrorFiles(target);
    if (oldTargetMoved) await guardedRemove(backup, paths);
    return resultFor(target, false);
  } catch (error) {
    if (oldTargetMoved && await pathExists(backup)) {
      if (await pathExists(target)) await guardedRemove(target, paths);
      await renamePath(backup, target);
    }
    throw error;
  } finally {
    if (await pathExists(staging)) await guardedRemove(staging, paths);
  }
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

async function guardedRemove(path: string, paths: ClaudePlusPlusPaths): Promise<void> {
  assertManagedMirrorPath(path, paths);
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
