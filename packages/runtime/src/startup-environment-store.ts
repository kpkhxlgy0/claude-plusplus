import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { StartupEnvironmentConfig, TweakManifest } from "@claude-plusplus/sdk";

export const STARTUP_ENVIRONMENT_SNAPSHOT_VERSION = 1;

interface StartupEnvironmentSnapshotDocument {
  version: 1;
  enabled: boolean;
  variables: Record<string, string>;
}

export interface StartupEnvironmentSnapshotRead {
  config: StartupEnvironmentConfig | null;
  error?: string;
}

export function startupEnvironmentSnapshotPath(userRoot: string, manifestId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(manifestId)) {
    throw new Error("Tweak id is invalid for startup environment storage");
  }
  const root = resolve(userRoot);
  const path = resolve(join(root, "startup-environment", `${manifestId}.json`));
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)) {
    throw new Error("Startup environment snapshot path escapes the Claude++ user root");
  }
  return path;
}

export function readStartupEnvironmentSnapshot(
  userRoot: string,
  manifest: TweakManifest,
): StartupEnvironmentSnapshotRead {
  try {
    const path = startupEnvironmentSnapshotPath(userRoot, manifest.id);
    if (!existsSync(path)) return { config: null };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const config = parseSnapshot(parsed, declaredKeys(manifest));
    return { config };
  } catch (error) {
    return { config: null, error: errorMessage(error) };
  }
}

export function writeStartupEnvironmentSnapshot(
  userRoot: string,
  manifest: TweakManifest,
  config: StartupEnvironmentConfig,
): void {
  const path = startupEnvironmentSnapshotPath(userRoot, manifest.id);
  const normalized = validateConfig(config, declaredKeys(manifest));
  const document: StartupEnvironmentSnapshotDocument = {
    version: STARTUP_ENVIRONMENT_SNAPSHOT_VERSION,
    enabled: normalized.enabled,
    variables: normalized.variables,
  };
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}

function parseSnapshot(value: unknown, keys: readonly string[]): StartupEnvironmentConfig {
  if (!isRecord(value)) throw new Error("Startup environment snapshot must be a JSON object");
  if (value.version !== STARTUP_ENVIRONMENT_SNAPSHOT_VERSION) {
    throw new Error("Startup environment snapshot version is unsupported");
  }
  return validateConfig({ enabled: value.enabled, variables: value.variables }, keys);
}

function validateConfig(value: unknown, keys: readonly string[]): StartupEnvironmentConfig {
  if (!isRecord(value)) throw new Error("Startup environment configuration must be an object");
  if (typeof value.enabled !== "boolean") {
    throw new Error("Startup environment configuration enabled must be a boolean");
  }
  if (!isRecord(value.variables)) {
    throw new Error("Startup environment configuration variables must be an object");
  }
  const variables = value.variables;
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error(`Startup environment configuration is missing declared key ${key}`);
    }
    if (typeof variables[key] !== "string") {
      throw new Error(`Startup environment configuration value for ${key} must be a string`);
    }
  }
  for (const key of Object.keys(variables)) {
    if (!expected.has(key)) {
      throw new Error(`Startup environment configuration contains undeclared key ${key}`);
    }
  }
  return {
    enabled: value.enabled,
    variables: Object.fromEntries(keys.map((key) => [key, variables[key] as string])),
  };
}

function declaredKeys(manifest: TweakManifest): readonly string[] {
  const keys = manifest.startupEnvironment?.keys;
  if (!keys || keys.length === 0) {
    throw new Error(`Tweak ${manifest.id} has no startup environment declaration`);
  }
  return keys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "Startup environment snapshot is not valid JSON";
  return error instanceof Error ? error.message : "Startup environment snapshot could not be read";
}
