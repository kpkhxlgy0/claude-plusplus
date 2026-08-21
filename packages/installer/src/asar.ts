import * as asar from "@electron/asar";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClaudePlusPlusPaths } from "./paths.js";
import { assertManagedMirrorPath } from "./windows-store-mirror.js";

const loaderName = "claude-plusplus-loader.cjs";

export interface ClaudePlusPlusLoaderMetadata {
  originalMain: string;
  userRoot: string;
  loaderVersion: string;
}

export interface ClaudePlusPlusLoaderInjectionOptions {
  managedAppRoot: string;
  asarPath: string;
  loaderPath: string;
  userRoot: string;
  loaderVersion: string;
}

export interface ClaudePlusPlusLoaderInspection {
  originalMain: string;
  injectedMain: typeof loaderName;
  metadata: ClaudePlusPlusLoaderMetadata;
}

export function readAsarHeaderHash(asarPath: string): string {
  clearAsarCache(asarPath);
  const raw = (asar as unknown as {
    getRawHeader(path: string): { headerString: string };
  }).getRawHeader(asarPath);
  return createHash("sha256").update(raw.headerString).digest("hex");
}

export async function injectClaudePlusPlusLoader(
  options: ClaudePlusPlusLoaderInjectionOptions,
  paths: ClaudePlusPlusPaths,
): Promise<ClaudePlusPlusLoaderInspection> {
  assertManagedMirrorPath(options.managedAppRoot, paths);
  const expectedAsar = resolve(options.managedAppRoot, "resources", "app.asar");
  if (resolve(options.asarPath) !== expectedAsar) {
    throw new Error(`ASAR path is not the managed mirror app.asar: ${options.asarPath}`);
  }

  const work = await mkdtemp(join(tmpdir(), "claudepp-asar-"));
  const extracted = join(work, "source");
  const stagingAsar = `${options.asarPath}.staging-${randomUUID()}`;
  const backupAsar = `${options.asarPath}.backup-${randomUUID()}`;
  let originalMoved = false;

  try {
    clearAsarCache(options.asarPath);
    const unpackOptions = collectUnpackOptions(options.asarPath);
    asar.extractAll(options.asarPath, extracted);
    const packagePath = join(extracted, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    const metadata = readExistingMetadata(packageJson);
    const originalMain = metadata?.originalMain ?? requireNonEmptyString(packageJson.main, "package.json main");
    const nextMetadata: ClaudePlusPlusLoaderMetadata = {
      originalMain,
      userRoot: options.userRoot,
      loaderVersion: options.loaderVersion,
    };

    packageJson.main = loaderName;
    packageJson.__claudepp = nextMetadata;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await copyFile(options.loaderPath, join(extracted, loaderName));
    await asar.createPackageWithOptions(extracted, stagingAsar, {
      globOptions: { dot: true },
      ...unpackOptions,
    });

    await rename(options.asarPath, backupAsar);
    originalMoved = true;
    await rename(stagingAsar, options.asarPath);
    clearAsarCache(options.asarPath);
    const inspection = inspectClaudePlusPlusLoader(options.asarPath);
    if (!inspection) throw new Error("Injected Claude++ Loader metadata could not be verified");
    await rm(backupAsar, { force: true });
    originalMoved = false;
    return inspection;
  } catch (error) {
    if (originalMoved && existsSync(backupAsar)) {
      if (existsSync(options.asarPath)) await rm(options.asarPath, { force: true });
      await rename(backupAsar, options.asarPath);
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(stagingAsar, { force: true });
    await rm(`${stagingAsar}.unpacked`, { recursive: true, force: true });
  }
}

export function inspectClaudePlusPlusLoader(
  asarPath: string,
): ClaudePlusPlusLoaderInspection | null {
  try {
    clearAsarCache(asarPath);
    const packageJson = JSON.parse(
      asar.extractFile(asarPath, "package.json").toString("utf8"),
    ) as Record<string, unknown>;
    if (packageJson.main !== loaderName) return null;
    const metadata = readExistingMetadata(packageJson);
    if (!metadata) return null;
    return { originalMain: metadata.originalMain, injectedMain: loaderName, metadata };
  } catch {
    return null;
  }
}

function clearAsarCache(asarPath: string): void {
  (asar as unknown as { uncache(path: string): void }).uncache(asarPath);
}

function readExistingMetadata(
  packageJson: Record<string, unknown>,
): ClaudePlusPlusLoaderMetadata | null {
  const value = packageJson.__claudepp;
  if (!isRecord(value)) return null;
  if (
    typeof value.originalMain !== "string" || !value.originalMain ||
    typeof value.userRoot !== "string" || !value.userRoot ||
    typeof value.loaderVersion !== "string" || !value.loaderVersion
  ) {
    return null;
  }
  return {
    originalMain: value.originalMain,
    userRoot: value.userRoot,
    loaderVersion: value.loaderVersion,
  };
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  if (value === loaderName) throw new Error("Existing Claude++ Loader metadata is missing or invalid");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectUnpackOptions(asarPath: string): { unpack?: string; unpackDir?: string } {
  if (!existsSync(`${asarPath}.unpacked`)) return {};
  const raw = (asar as unknown as {
    getRawHeader(path: string): { header: Record<string, unknown> };
  }).getRawHeader(asarPath);
  const covers = unpackCovers(raw.header, "").covers;
  const dirs = covers.filter((cover) => cover.type === "dir").map((cover) => stripSlash(cover.path));
  const files = covers.filter((cover) => cover.type === "file").map((cover) => `**/${stripSlash(cover.path)}`);
  return {
    ...(files.length > 0 ? { unpack: bracePattern(files) } : {}),
    ...(dirs.length > 0 ? { unpackDir: bracePattern(dirs) } : {}),
  };
}

interface UnpackCover {
  type: "dir" | "file";
  path: string;
}

function unpackCovers(
  node: Record<string, unknown>,
  prefix: string,
): { total: number; unpacked: number; covers: UnpackCover[] } {
  const files = (node as { files?: Record<string, Record<string, unknown>> }).files;
  if (!files) return { total: 0, unpacked: 0, covers: [] };

  let total = 0;
  let unpacked = 0;
  const covers: UnpackCover[] = [];
  for (const [name, value] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    if (value.files) {
      const child = unpackCovers(value, path);
      total += child.total;
      unpacked += child.unpacked;
      covers.push(...child.covers);
    } else {
      total += 1;
      if (value.unpacked) {
        unpacked += 1;
        covers.push({ type: "file", path });
      }
    }
  }
  if (prefix && total > 0 && total === unpacked) {
    return { total, unpacked, covers: [{ type: "dir", path: prefix }] };
  }
  return { total, unpacked, covers };
}

function stripSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function bracePattern(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}
