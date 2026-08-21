# SDK and API reference

`@claude-plusplus/sdk` is a types-and-validation package. Runtime code receives one `TweakApi` lease per process; it
does not import the SDK at run time unless your bundle includes it.

```ts
import type {
  Tweak,
  TweakApi,
  TweakManifest,
} from "@claude-plusplus/sdk";
```

Use the local package as described in [TypeScript and bundling](./typescript-and-bundling.md). Renderer Tweaks have no
Node `require`. Main Tweaks are trusted local Node.js code, and manifest permissions constrain Claude++ API leases—not
the operating-system access of malicious Main code.

## Lifecycle, validation, and manifest exports

```ts
interface Tweak {
  start(api: TweakApi): void | Promise<void>;
  stop?(): void | Promise<void>;
}

function defineTweak(tweak: Tweak): Tweak;
function validateTweakManifest(manifest: unknown): TweakManifestValidationResult;

interface TweakManifestValidationResult {
  ok: boolean;
  errors: TweakManifestIssue[];
  warnings: TweakManifestIssue[];
}

interface TweakManifestIssue {
  path: string;
  message: string;
}
```

`defineTweak` is an identity helper for type inference. `validateTweakManifest` validates JSON shape and permission
coupling; it does not inspect the filesystem entry. The CLI adds that check.

The SDK also exports `VALID_TWEAK_SCOPES`, `VALID_TWEAK_PERMISSIONS`, `TweakScope`, `TweakPermission`,
`TweakManifest`, `TweakAuthor`, `StartupEnvironmentDeclaration`, and `ClaudeCodeSettingsDeclaration`. See the
[Manifest reference](./manifest.md) for their complete fields and Runtime rules.

## `TweakApi` availability

```ts
interface TweakApi {
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
```

| Property | Renderer | Main | Gate |
| --- | ---: | ---: | --- |
| `manifest`, `storage`, `process`, `log`, `ipc`, `fs` | yes | yes | Always delivered; `fs` operations require `filesystem`. |
| `settings` | yes | no | `settings` |
| `claude.sessions` | yes | no | `claude-sessions` |
| `startupEnvironment` | no | yes | `startup-environment` plus declaration |
| `claudeCodeSettings` | no | yes | `claude-code-settings` plus declaration |
| `mcp` | no | yes | `mcp` |
| `claude.sessionTitles` | no | yes | `claude-session-title-write` |

The `network` permission is review metadata in the current Runtime: there is no dedicated SDK network API or Runtime
network guard.

## Always-present common APIs

### Manifest and process

`api.manifest` is the validated manifest for this lease. Treat it as read-only. `api.process` is the branch authority
for a `scope: "both"` entry; do not infer process from optional global objects.

### Storage

```ts
interface TweakStorage {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}
```

Main storage persists as a per-Tweak JSON file. Renderer storage uses a per-Tweak `localStorage` key. `all()` returns a
defensive top-level copy; values should be JSON-compatible if they must survive restart.

### Logging

```ts
interface TweakLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

Main writes `main.log`. Renderer mirrors formatted messages to `renderer.log` and writes `[Claude++]` entries to
DevTools.

### Namespaced IPC

```ts
interface TweakIpc {
  on(channel: string, handler: (...args: unknown[]) => void): () => void;
  send(channel: string, ...args: unknown[]): void;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  handle?(channel: string, handler: (...args: unknown[]) => unknown): void;
}
```

Local channel names start with an alphanumeric character, contain at most 64 letters/digits/dots/underscores/dashes,
and are namespaced by Runtime as `claudepp:<tweak-id>:<channel>`.

- Renderer supports `on`, `send`, and `invoke`; calling `handle` rejects.
- Main supports `on`, `send` to live Renderer web contents, and `handle`; calling `invoke` rejects.
- `on` returns an unsubscribe function. Main handlers and remaining listeners are removed when the lease is disposed.
- Renderer `invoke` has a five-second timeout in the current Runtime.

The `ipc` permission declares intent, but `api.ipc` is currently supplied to both processes regardless of that entry.

### Contained filesystem

```ts
interface TweakFs {
  dataDir: string;
  read(relPath: string): Promise<string>;
  write(relPath: string, contents: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}
```

The object is always present, but each operation rejects unless the manifest includes `filesystem`. Paths must be
relative and remain below `%APPDATA%\claude-plusplus\tweak-data\<tweak-id>`. Renderer operations are proxied through
Main; its `dataDir` string is descriptive rather than a local Node path.

## Renderer permission-gated APIs

### Settings (`settings`)

```ts
interface SettingsApi {
  register(section: SettingsSection): SettingsHandle;
  registerPage(page: SettingsPage): SettingsHandle;
}

interface SettingsSection {
  id: string;
  title: string;
  description?: string;
  render(root: HTMLElement): void | (() => void);
}

interface SettingsPage {
  id: string;
  title: string;
  description?: string;
  iconSvg?: string;
  render(root: HTMLElement): void | (() => void);
}

interface SettingsHandle {
  unregister(): void;
}
```

Ids are local to the Tweak. Track and unregister handles in `stop()`; Runtime also tracks them on the Renderer lease.
A render cleanup function can release page-local listeners before rerender/unregister. Build UI with DOM APIs; the
public SDK does not promise React or JSX helpers.

### Claude Sessions (`claude-sessions`)

```ts
interface ClaudeSessionsApi {
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

interface ClaudeApi {
  sessions?: ClaudeSessionsApi;
  sessionTitles?: ClaudeSessionTitlesApi;
}
```

`api.claude.sessions` is a focused Renderer adapter for public session file resolution, visible transcript file-link
resolution, and a session workspace root. A missing/unresolvable reference returns `null`. Retained references reject
after lease disposal.

## Main permission-gated APIs

### Startup environment (`startup-environment`)

```ts
interface StartupEnvironmentDeclaration {
  keys: string[];
}

interface StartupEnvironmentConfig {
  enabled: boolean;
  variables: Record<string, string>;
}

interface StartupEnvironmentStatus {
  saved: StartupEnvironmentConfig | null;
  applied: StartupEnvironmentConfig | null;
  restartRequired: boolean;
  error?: string;
}

interface StartupEnvironmentApi {
  getStatus(): StartupEnvironmentStatus;
  save(config: StartupEnvironmentConfig): StartupEnvironmentStatus;
  relaunch(): void;
}
```

The manifest must declare the permission and exact keys together. `save` persists a complete next-launch group;
`restartRequired` compares saved and applied snapshots. `relaunch` restores the incoming baseline before scheduling an
app relaunch. See [Advanced Claude-specific capabilities](../tweak-authoring.md#startup-environment-capability).

### Claude Code settings (`claude-code-settings`)

```ts
type ClaudeCodeSettingsJsonValue =
  | null | boolean | number | string
  | ClaudeCodeSettingsJsonValue[]
  | { [key: string]: ClaudeCodeSettingsJsonValue };

interface ClaudeCodeSettingsDeclaration {
  paths: string[];
}

interface ClaudeCodeSettingsRead {
  exists: boolean;
  value?: ClaudeCodeSettingsJsonValue;
  revision: string;
}

interface ClaudeCodeSettingsApi {
  read(path: string): ClaudeCodeSettingsRead;
  write(
    path: string,
    value: ClaudeCodeSettingsJsonValue,
    expectedRevision: string,
  ): ClaudeCodeSettingsRead;
  remove(path: string, expectedRevision: string): ClaudeCodeSettingsRead;
}
```

Each operation requires an exact declared path. Mutations use the whole-file revision returned by the preceding read;
stale revisions reject instead of overwriting an external change. This is focused settings access, not general file
access. See [Claude Code settings capability](../tweak-authoring.md#claude-code-settings-capability).

### In-process MCP (`mcp`)

```ts
interface TweakMcpToolContext {
  callerSessionId: string;
}

interface TweakMcpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface TweakMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    input: Record<string, unknown>,
    context: TweakMcpToolContext,
  ): TweakMcpCallResult | Promise<TweakMcpCallResult>;
}

interface TweakMcpServer {
  name: string;
  version?: string;
  tools: readonly TweakMcpTool[];
}

interface TweakMcpRegistration {
  unregister(): Promise<void>;
}

interface TweakMcpApi {
  registerServer(server: TweakMcpServer): Promise<TweakMcpRegistration>;
}
```

Servers and tool handlers run inside compatible Claude Desktop processes. Server names start with `claudepp_`; server
and tool names otherwise use lowercase letters, digits, `_`, and `-`. Track the returned registration and unregister
it during `stop()`; lease disposal revokes every remaining owned server. Claude++ does not write external MCP
configuration for this API.

### Session titles (`claude-session-title-write`)

```ts
interface ClaudeSessionTitleUpdate {
  sessionId: string;
  title: string;
}

interface ClaudeSessionTitlesApi {
  setTitle(
    sessionId: string,
    title: string,
    context?: Readonly<TweakMcpToolContext>,
  ): Promise<ClaudeSessionTitleUpdate>;
}
```

The explicit `sessionId` selects the target. When called from an MCP tool, pass the unchanged caller context for
audited Claude Code UUID correlation. This capability depends on a supported private Claude Desktop boundary and fails
closed when compatibility checks do not match. See
[Desktop runtime MCP and session titles](../tweak-authoring.md#desktop-runtime-mcp-and-session-titles).
