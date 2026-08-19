export const VALID_TWEAK_SCOPES = ["renderer", "main", "both"] as const;

export const VALID_TWEAK_PERMISSIONS = [
  "ipc",
  "filesystem",
  "network",
  "settings",
  "claude-sessions",
  "startup-environment",
  "claude-code-settings",
  "mcp",
  "claude-session-title-write",
] as const;

export type TweakScope = (typeof VALID_TWEAK_SCOPES)[number];
export type TweakPermission = (typeof VALID_TWEAK_PERMISSIONS)[number];

export interface StartupEnvironmentDeclaration {
  keys: string[];
}

export interface StartupEnvironmentConfig {
  enabled: boolean;
  variables: Record<string, string>;
}

export interface StartupEnvironmentStatus {
  saved: StartupEnvironmentConfig | null;
  applied: StartupEnvironmentConfig | null;
  restartRequired: boolean;
  error?: string;
}

export interface StartupEnvironmentApi {
  getStatus(): StartupEnvironmentStatus;
  save(config: StartupEnvironmentConfig): StartupEnvironmentStatus;
  relaunch(): void;
}

export type ClaudeCodeSettingsJsonValue =
  | null
  | boolean
  | number
  | string
  | ClaudeCodeSettingsJsonValue[]
  | { [key: string]: ClaudeCodeSettingsJsonValue };

export interface ClaudeCodeSettingsDeclaration {
  paths: string[];
}

export interface ClaudeCodeSettingsRead {
  exists: boolean;
  value?: ClaudeCodeSettingsJsonValue;
  revision: string;
}

export interface ClaudeCodeSettingsApi {
  read(path: string): ClaudeCodeSettingsRead;
  write(
    path: string,
    value: ClaudeCodeSettingsJsonValue,
    expectedRevision: string,
  ): ClaudeCodeSettingsRead;
  remove(path: string, expectedRevision: string): ClaudeCodeSettingsRead;
}

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
  startupEnvironment?: StartupEnvironmentDeclaration;
  claudeCodeSettings?: ClaudeCodeSettingsDeclaration;
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

export interface TweakMcpToolContext {
  callerSessionId: string;
}

export interface TweakMcpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface TweakMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    input: Record<string, unknown>,
    context: TweakMcpToolContext,
  ): TweakMcpCallResult | Promise<TweakMcpCallResult>;
}

export interface TweakMcpServer {
  name: string;
  version?: string;
  tools: readonly TweakMcpTool[];
}

export interface TweakMcpRegistration {
  unregister(): Promise<void>;
}

export interface TweakMcpApi {
  registerServer(server: TweakMcpServer): Promise<TweakMcpRegistration>;
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

export interface ClaudeSessionTitleUpdate {
  sessionId: string;
  title: string;
}

export interface ClaudeSessionTitlesApi {
  setTitle(sessionId: string, title: string): Promise<ClaudeSessionTitleUpdate>;
}

export interface ClaudeApi {
  sessions?: ClaudeSessionsApi;
  sessionTitles?: ClaudeSessionTitlesApi;
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
  mcp?: TweakMcpApi;
  startupEnvironment?: StartupEnvironmentApi;
  claudeCodeSettings?: ClaudeCodeSettingsApi;
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
        if (manifest.scope === "renderer" &&
          (permission === "mcp" || permission === "claude-session-title-write")) {
          errors.push({
            path: `permissions[${index}]`,
            message: "permission requires a Main-capable Tweak scope",
          });
        }
      });
    }
  }

  const hasStartupEnvironmentPermission = Array.isArray(manifest.permissions) &&
    manifest.permissions.includes("startup-environment");
  const hasStartupEnvironmentDeclaration = manifest.startupEnvironment !== undefined;
  if (hasStartupEnvironmentPermission !== hasStartupEnvironmentDeclaration) {
    errors.push({
      path: "startupEnvironment",
      message: "startupEnvironment permission and declaration must be provided together",
    });
  }
  if (hasStartupEnvironmentDeclaration) {
    if (!isRecord(manifest.startupEnvironment)) {
      errors.push({ path: "startupEnvironment", message: "startupEnvironment must be an object" });
    } else {
      const keys = manifest.startupEnvironment.keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        errors.push({
          path: "startupEnvironment.keys",
          message: "startupEnvironment.keys must be a non-empty array",
        });
      } else {
        const seen = new Set<string>();
        keys.forEach((key, index) => {
          if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            errors.push({
              path: `startupEnvironment.keys[${index}]`,
              message: "startup environment key must be a valid environment variable name",
            });
            return;
          }
          if (seen.has(key)) {
            errors.push({
              path: `startupEnvironment.keys[${index}]`,
              message: "startup environment keys must be unique",
            });
          }
          seen.add(key);
        });
      }
    }
    if (manifest.scope === "renderer") {
      errors.push({
        path: "startupEnvironment",
        message: "startup environment requires a Main-capable Tweak scope",
      });
    }
  }

  const hasClaudeCodeSettingsPermission = Array.isArray(manifest.permissions) &&
    manifest.permissions.includes("claude-code-settings");
  const hasClaudeCodeSettingsDeclaration = manifest.claudeCodeSettings !== undefined;
  if (hasClaudeCodeSettingsPermission !== hasClaudeCodeSettingsDeclaration) {
    errors.push({
      path: "claudeCodeSettings",
      message: "claude-code-settings permission and claudeCodeSettings declaration must be provided together",
    });
  }
  if (hasClaudeCodeSettingsDeclaration) {
    if (!isRecord(manifest.claudeCodeSettings)) {
      errors.push({ path: "claudeCodeSettings", message: "claudeCodeSettings must be an object" });
    } else {
      const paths = manifest.claudeCodeSettings.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        errors.push({
          path: "claudeCodeSettings.paths",
          message: "claudeCodeSettings.paths must be a non-empty array",
        });
      } else if (paths.length > 64) {
        errors.push({
          path: "claudeCodeSettings.paths",
          message: "claudeCodeSettings.paths may contain at most 64 paths",
        });
      } else {
        const validPaths: Array<{ path: string; index: number; segments: string[] }> = [];
        const seen = new Set<string>();
        paths.forEach((path, index) => {
          const issue = validateClaudeCodeSettingsPath(path);
          if (issue) {
            errors.push({ path: `claudeCodeSettings.paths[${index}]`, message: issue });
            return;
          }
          if (seen.has(path as string)) {
            errors.push({
              path: `claudeCodeSettings.paths[${index}]`,
              message: "Claude Code settings paths must be unique",
            });
            return;
          }
          seen.add(path as string);
          validPaths.push({ path: path as string, index, segments: (path as string).split(".") });
        });
        for (let leftIndex = 0; leftIndex < validPaths.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < validPaths.length; rightIndex += 1) {
            const left = validPaths[leftIndex];
            const right = validPaths[rightIndex];
            const shorter = left.segments.length <= right.segments.length ? left : right;
            const longer = shorter === left ? right : left;
            const overlaps = shorter.segments.every(
              (segment, segmentIndex) => longer.segments[segmentIndex] === segment,
            );
            if (overlaps) {
              errors.push({
                path: `claudeCodeSettings.paths[${longer.index}]`,
                message: `Claude Code settings paths must not overlap (${shorter.path})`,
              });
            }
          }
        }
      }
    }
    if (manifest.scope === "renderer") {
      errors.push({
        path: "claudeCodeSettings",
        message: "Claude Code settings access requires a Main-capable Tweak scope",
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateClaudeCodeSettingsPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return "Claude Code settings path must be a non-empty string of at most 256 characters";
  }
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)) {
    return "Claude Code settings path must contain dot-separated identifier-like segments";
  }
  const unsafe = new Set(["__proto__", "prototype", "constructor"]);
  if (value.split(".").some((segment) => unsafe.has(segment))) {
    return "Claude Code settings path contains an unsafe segment";
  }
  return null;
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
