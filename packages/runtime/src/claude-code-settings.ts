import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ClaudeCodeSettingsApi,
  ClaudeCodeSettingsJsonValue,
  ClaudeCodeSettingsRead,
  TweakLogger,
  TweakManifest,
} from "@claude-plusplus/sdk";

const MISSING_REVISION = "missing:v1";
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

interface SettingsDocumentRead {
  exists: boolean;
  raw: string;
  revision: string;
  document: Record<string, unknown>;
}

export interface ClaudeCodeSettingsApiLease {
  api: ClaudeCodeSettingsApi;
  dispose(): void;
}

export interface ClaudeCodeSettingsService {
  settingsFile: string;
  createApiLease(manifest: TweakManifest): ClaudeCodeSettingsApiLease;
}

export interface ClaudeCodeSettingsServiceOptions {
  settingsFile: string;
  log: TweakLogger;
}

export function resolveClaudeCodeSettingsFile(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const root = configured ? resolve(configured) : join(home, ".claude");
  return join(root, "settings.json");
}

export function initializeClaudeCodeSettings(
  options: ClaudeCodeSettingsServiceOptions,
): ClaudeCodeSettingsService {
  const settingsFile = resolve(options.settingsFile);
  return {
    settingsFile,
    createApiLease(manifest): ClaudeCodeSettingsApiLease {
      assertManifestPermission(manifest);
      const allowed = new Set(manifest.claudeCodeSettings?.paths ?? []);
      let disposed = false;
      const assertActive = (): void => {
        if (disposed) throw new Error("Claude Code settings API lease is disposed");
      };
      const assertAllowed = (path: string): void => {
        if (!allowed.has(path)) {
          throw new Error(`Claude Code settings path is not declared by ${manifest.id}: ${path}`);
        }
      };
      return {
        api: {
          read(path): ClaudeCodeSettingsRead {
            assertActive();
            assertAllowed(path);
            return readSetting(settingsFile, path);
          },
          write(path, value, expectedRevision): ClaudeCodeSettingsRead {
            assertActive();
            assertAllowed(path);
            const result = writeSetting(settingsFile, path, value, expectedRevision);
            options.log.info(`${manifest.id} wrote Claude Code setting ${path}`);
            return result;
          },
          remove(path, expectedRevision): ClaudeCodeSettingsRead {
            assertActive();
            assertAllowed(path);
            const result = removeSetting(settingsFile, path, expectedRevision);
            options.log.info(`${manifest.id} removed Claude Code setting ${path}`);
            return result;
          },
        },
        dispose(): void {
          disposed = true;
        },
      };
    },
  };
}

export function readSetting(settingsFile: string, path: string): ClaudeCodeSettingsRead {
  const source = readSettingsDocument(settingsFile);
  return snapshot(source.document, path, source.revision);
}

export function writeSetting(
  settingsFile: string,
  path: string,
  value: ClaudeCodeSettingsJsonValue,
  expectedRevision: string,
): ClaudeCodeSettingsRead {
  validateJsonValue(value);
  const next = cloneJsonValue(value);
  validateJsonValue(next);
  return mutateSettings(settingsFile, path, expectedRevision, (document, segments) => {
    const parent = resolveParent(document, segments, true);
    if (!parent) throw new Error("Claude Code settings path parent could not be created");
    const key = segments.at(-1) as string;
    if (hasOwn(parent, key) && jsonEquals(parent[key], next)) return false;
    parent[key] = next;
    return true;
  });
}

export function removeSetting(
  settingsFile: string,
  path: string,
  expectedRevision: string,
): ClaudeCodeSettingsRead {
  return mutateSettings(settingsFile, path, expectedRevision, (document, segments) => {
    const parent = resolveParent(document, segments, false);
    if (!parent) return false;
    const key = segments.at(-1) as string;
    if (!hasOwn(parent, key)) return false;
    delete parent[key];
    return true;
  });
}

function mutateSettings(
  settingsFile: string,
  path: string,
  expectedRevision: string,
  mutate: (document: Record<string, unknown>, segments: string[]) => boolean,
): ClaudeCodeSettingsRead {
  const segments = parsePath(path);
  const source = readSettingsDocument(settingsFile);
  assertRevision(source.revision, expectedRevision);
  const document = cloneDocument(source.document);
  const changed = mutate(document, segments);
  if (!changed) return snapshot(source.document, path, source.revision);

  const raw = `${JSON.stringify(document, null, 2)}\n`;
  mkdirSync(dirname(settingsFile), { recursive: true });
  assertRevision(readSettingsDocument(settingsFile).revision, expectedRevision);
  const staging = `${settingsFile}.claude-plusplus-${randomUUID()}`;
  try {
    writeFileSync(staging, raw, { encoding: "utf8", flag: "wx" });
    assertRevision(readSettingsDocument(settingsFile).revision, expectedRevision);
    renameSync(staging, settingsFile);
  } finally {
    rmSync(staging, { force: true });
  }
  return snapshot(document, path, revisionFor(raw));
}

function readSettingsDocument(settingsFile: string): SettingsDocumentRead {
  const item = lstatSync(settingsFile, { throwIfNoEntry: false });
  if (!item) {
    return { exists: false, raw: "", revision: MISSING_REVISION, document: {} };
  }
  if (item.isSymbolicLink()) {
    throw new Error("Claude Code settings file must not be a symbolic link");
  }
  const raw = readFileSync(settingsFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/u, ""));
  } catch {
    throw new Error("Claude Code settings file is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Claude Code settings file root must be a JSON object");
  }
  validateJsonValue(parsed);
  return {
    exists: true,
    raw,
    revision: revisionFor(raw),
    document: parsed,
  };
}

function snapshot(
  document: Record<string, unknown>,
  path: string,
  revision: string,
): ClaudeCodeSettingsRead {
  const segments = parsePath(path);
  let current: Record<string, unknown> = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!hasOwn(current, segment)) return { exists: false, revision };
    const next = current[segment];
    if (!isRecord(next)) {
      throw new Error(`Claude Code settings path cannot traverse non-object segment ${segment}`);
    }
    current = next;
  }
  const key = segments.at(-1) as string;
  if (!hasOwn(current, key)) return { exists: false, revision };
  const value = current[key];
  validateJsonValue(value);
  return { exists: true, value: cloneJsonValue(value as ClaudeCodeSettingsJsonValue), revision };
}

function resolveParent(
  document: Record<string, unknown>,
  segments: string[],
  create: boolean,
): Record<string, unknown> | null {
  let current = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!hasOwn(current, segment)) {
      if (!create) return null;
      const next = Object.create(null) as Record<string, unknown>;
      current[segment] = next;
      current = next;
      continue;
    }
    const next = current[segment];
    if (!isRecord(next)) {
      throw new Error(`Claude Code settings path cannot traverse non-object segment ${segment}`);
    }
    current = next;
  }
  return current;
}

function parsePath(path: string): string[] {
  if (typeof path !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new Error("Claude Code settings path is invalid");
  }
  const segments = path.split(".");
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) {
    throw new Error("Claude Code settings path contains an unsafe segment");
  }
  return segments;
}

function validateJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Claude Code setting contains a non-finite number");
    return;
  }
  if (typeof value !== "object") throw new Error("Claude Code setting must be valid JSON data");
  if (seen.has(value)) throw new Error("Claude Code setting must not contain circular references");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, seen);
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Claude Code setting object must use a plain object prototype");
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_SEGMENTS.has(key)) throw new Error("Claude Code setting contains an unsafe object key");
    validateJsonValue(item, seen);
  }
  seen.delete(value);
}

function cloneDocument(document: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

function cloneJsonValue<T extends ClaudeCodeSettingsJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function revisionFor(raw: string): string {
  return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function assertRevision(actual: string, expected: string): void {
  if (typeof expected !== "string" || expected.length === 0 || actual !== expected) {
    throw new Error("Claude Code settings changed since they were read; reload and try again");
  }
}

function assertManifestPermission(manifest: TweakManifest): void {
  if (!manifest.permissions?.includes("claude-code-settings")) {
    throw new Error(`Tweak ${manifest.id} lacks claude-code-settings permission`);
  }
  if (!manifest.claudeCodeSettings?.paths.length) {
    throw new Error(`Tweak ${manifest.id} has no Claude Code settings path declaration`);
  }
  if (manifest.scope === "renderer") {
    throw new Error(`Tweak ${manifest.id} cannot access Claude Code settings from Renderer scope`);
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
