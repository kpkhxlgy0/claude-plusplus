export const VALID_TWEAK_SCOPES = ["renderer", "main", "both"] as const;

export const VALID_TWEAK_PERMISSIONS = [
  "ipc",
  "filesystem",
  "network",
  "settings",
  "claude-sessions",
] as const;

export type TweakScope = (typeof VALID_TWEAK_SCOPES)[number];
export type TweakPermission = (typeof VALID_TWEAK_PERMISSIONS)[number];

export interface TweakManifest {
  id: string;
  name: string;
  version: string;
  githubRepo: string;
  description?: string;
  author?: string | TweakAuthor;
  homepage?: string;
  iconUrl?: string;
  tags?: string[];
  minRuntime?: string;
  scope?: TweakScope;
  main?: string;
  permissions?: TweakPermission[];
}

export interface TweakAuthor {
  name: string;
  url?: string;
  email?: string;
}

export interface TweakLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface TweakStorage {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

export interface SettingsSection {
  id: string;
  title: string;
  description?: string;
  render(root: HTMLElement): void | (() => void);
}

export interface SettingsPage {
  id: string;
  title: string;
  description?: string;
  iconSvg?: string;
  render(root: HTMLElement): void | (() => void);
}

export interface SettingsHandle {
  unregister(): void;
}

export interface SettingsApi {
  register(section: SettingsSection): SettingsHandle;
  registerPage(page: SettingsPage): SettingsHandle;
}

export interface TweakIpc {
  on(channel: string, handler: (...args: unknown[]) => void): () => void;
  send(channel: string, ...args: unknown[]): void;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  handle?(channel: string, handler: (...args: unknown[]) => unknown): void;
}

export interface TweakFs {
  dataDir: string;
  read(relPath: string): Promise<string>;
  write(relPath: string, contents: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

export interface ClaudeSessionsApi {
  resolveFile(sessionId: string, filePath: string): Promise<string | null>;
  resolveReference(
    sessionId: string,
    entryId: string,
    label: string,
    occurrence: number,
    visibleCount: number,
  ): Promise<string | null>;
  getWorkspaceRoot(sessionId: string): Promise<string | null>;
}

export interface ClaudeApi {
  sessions: ClaudeSessionsApi;
}

export interface TweakApi {
  manifest: Readonly<TweakManifest>;
  storage: TweakStorage;
  process: "renderer" | "main";
  log: TweakLogger;
  settings?: SettingsApi;
  ipc: TweakIpc;
  fs: TweakFs;
  claude?: ClaudeApi;
}

export interface Tweak {
  start(api: TweakApi): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface TweakManifestIssue {
  path: string;
  message: string;
}

export interface TweakManifestValidationResult {
  ok: boolean;
  errors: TweakManifestIssue[];
  warnings: TweakManifestIssue[];
}

export function defineTweak(tweak: Tweak): Tweak {
  return tweak;
}

export function validateTweakManifest(manifest: unknown): TweakManifestValidationResult {
  const errors: TweakManifestIssue[] = [];
  const warnings: TweakManifestIssue[] = [];

  if (!isRecord(manifest)) {
    return {
      ok: false,
      errors: [{ path: "$", message: "manifest must be a JSON object" }],
      warnings,
    };
  }

  requireString(manifest, "id", errors);
  requireString(manifest, "name", errors);
  requireString(manifest, "version", errors);
  requireString(manifest, "githubRepo", errors);

  if (typeof manifest.id === "string" && !/^[a-zA-Z0-9._-]+$/.test(manifest.id)) {
    errors.push({
      path: "id",
      message: "id may only contain letters, numbers, dots, underscores, and dashes",
    });
  }

  if (typeof manifest.githubRepo === "string" && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(manifest.githubRepo)) {
    errors.push({ path: "githubRepo", message: "githubRepo must use owner/repo format" });
  }

  if (typeof manifest.version === "string" && !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)) {
    warnings.push({ path: "version", message: "version should be semver, for example 0.2.0" });
  }

  if (manifest.scope === undefined) {
    warnings.push({ path: "scope", message: "scope is omitted and defaults to both" });
  } else if (!VALID_TWEAK_SCOPES.includes(manifest.scope as TweakScope)) {
    errors.push({ path: "scope", message: "scope must be renderer, main, or both" });
  }

  optionalString(manifest, "description", errors);
  optionalString(manifest, "homepage", errors);
  optionalString(manifest, "iconUrl", errors);
  optionalString(manifest, "main", errors);

  if (manifest.author !== undefined) {
    if (typeof manifest.author !== "string" && !isRecord(manifest.author)) {
      errors.push({ path: "author", message: "author must be a string or object" });
    } else if (isRecord(manifest.author)) {
      requireString(manifest.author, "name", errors, "author.name");
      optionalString(manifest.author, "url", errors, "author.url");
      optionalString(manifest.author, "email", errors, "author.email");
    }
  }

  if (manifest.tags !== undefined &&
    (!Array.isArray(manifest.tags) || !manifest.tags.every((tag) => typeof tag === "string"))) {
    errors.push({ path: "tags", message: "tags must be an array of strings" });
  }

  if (manifest.minRuntime !== undefined &&
    (typeof manifest.minRuntime !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.minRuntime))) {
    errors.push({ path: "minRuntime", message: "minRuntime must use numeric x.y.z format" });
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      errors.push({ path: "permissions", message: "permissions must be an array" });
    } else {
      manifest.permissions.forEach((permission, index) => {
        if (typeof permission !== "string" || !VALID_TWEAK_PERMISSIONS.includes(permission as TweakPermission)) {
          errors.push({
            path: `permissions[${index}]`,
            message: "permission must be a known Claude++ permission string",
          });
        }
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  errors: TweakManifestIssue[],
  path = key,
): void {
  if (typeof record[key] !== "string" || record[key] === "") {
    errors.push({ path, message: `${path} is required and must be a non-empty string` });
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  errors: TweakManifestIssue[],
  path = key,
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    errors.push({ path, message: `${path} must be a string` });
  }
}
