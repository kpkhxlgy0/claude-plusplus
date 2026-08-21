# Advanced Claude-specific Tweak capabilities

Return to the [complete Tweak author workflow](./tweaks/README.md) for scaffolding, manifests, lifecycle, the public API,
bundling, and distribution.

Claude++ Tweaks are CommonJS modules with a `start(api)` lifecycle and an optional `stop()` lifecycle. Their `manifest.json` declares both the processes in which they run and the capabilities exposed by each process-specific API lease.

This advanced guide covers Claude-specific Main capabilities: startup environment, exact-path Claude Code settings,
handler-backed in-process MCP, and session-title writes. Main Tweaks are trusted local Node.js code. Permissions control
Claude++ API leases; they are not an operating-system sandbox.

## Startup environment capability

Use startup environment only when a Tweak must own a fixed set of environment keys for the next managed Claude
launch. The permission and declaration are inseparable, and the manifest must be Main-capable:

```json
{
  "scope": "both",
  "permissions": [
    "ipc",
    "settings",
    "startup-environment"
  ],
  "startupEnvironment": {
    "keys": [
      "EXAMPLE_MAX_TOKENS",
      "EXAMPLE_COMPACT_THRESHOLD"
    ]
  }
}
```

`startupEnvironment.keys` must be a non-empty list of unique environment-variable names. A Renderer-only Tweak, a
permission without its declaration, or a declaration without its permission is invalid. Only the Main API lease
exposes `api.startupEnvironment`:

```ts
interface StartupEnvironmentApi {
  getStatus(): StartupEnvironmentStatus;
  save(config: StartupEnvironmentConfig): StartupEnvironmentStatus;
  relaunch(): void;
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
```

`save()` requires exactly the declared keys with string values. It validates the complete group, writes a unique
sibling staging file, and atomically renames it to
`%APPDATA%\claude-plusplus\startup-environment\<tweak-id>.json`. Saving changes the next-launch snapshot; it does not
mutate the environment already applied to the running Claude process. `saved` is the persisted snapshot, `applied` is
the snapshot used for this launch, and `restartRequired` is their comparison. Do not assume every save requires a
restart: a disabled snapshot can already match the applied state.

At process startup, Claude++ considers only valid, enabled, Main-capable Tweaks that have this permission and
declaration. Safe Mode, a globally disabled Tweak, a disabled snapshot, malformed data, missing source, and conflicting
key ownership fail closed. Enabled snapshots are applied as whole groups before Claude's original main entry. Claude++
records each incoming value so it can restore the exact baseline; a partial assignment failure rolls back that group.

`relaunch()` restores the incoming baseline before asking the attached Claude app to relaunch and quit. If scheduling
the relaunch throws, Runtime attempts to reapply the current overlay and reports the error. This is a recovery path,
not a crash-proof or durable transaction guarantee; UI should also tell users how to quit and reopen Claude manually.
Malformed snapshots are retained as evidence and surfaced through `status.error` rather than silently rewritten.

The API is a revocable Main lease. Retained references reject after Tweak stop/reload disposes that lease. A reversible
Tweak should expose an explicit disable-and-save action, document that the new state applies after a full restart, and
tell users to disable the Tweak globally or remove it only after saving a disabled snapshot when recovery matters.

The production [GPT Context Window Tweak](https://github.com/kpkhxlgy0/gpt-context-window) demonstrates the complete
pattern: it declares exactly three owned keys, validates them as one group, shows saved/applied/restart-required status,
offers relaunch plus manual-restart recovery, and releases Main and Renderer state from `stop()`.

## Desktop runtime MCP and session titles

Claude++ 0.2.6 adds two Main-only permissions:

- `mcp` exposes `api.mcp.registerServer(...)` for handler-backed, in-process MCP servers.
- `claude-session-title-write` exposes `api.claude.sessionTitles.setTitle(sessionId, title)` for an explicit Claude
  Desktop manager key or the Claude Code CLI session UUID exposed inside the conversation.

Claude++ 0.2.7 lets a handler pass its caller context as the optional third `setTitle` argument. Versions through
0.2.8 attempted to read the reported Claude Code UUID from public session snapshots, but the current DDK snapshot
omits it. Runtime 0.2.9 instead uses the raw DDK record only to correlate the UUID, then revalidates the mapped key
through the public session lookup. Session-title Tweaks that accept that UUID must require Runtime 0.2.9.

Renderer-only manifests cannot request either permission, and Renderer API leases never expose either capability. A
Main-only manifest requesting both capabilities looks like this:

```json
{
  "id": "com.example.session-title",
  "name": "Example Session Title",
  "version": "0.1.1",
  "githubRepo": "example/session-title",
  "minRuntime": "0.2.9",
  "scope": "main",
  "main": "index.js",
  "permissions": [
    "mcp",
    "claude-session-title-write"
  ]
}
```

The following CommonJS Tweak registers one runnable MCP tool and releases its registration during `stop()`:

```js
let registration;

async function start(api) {
  if (api.process !== "main") return;
  if (!api.mcp || !api.claude?.sessionTitles) {
    throw new Error("This Tweak requires Claude++ 0.2.9 or newer.");
  }

  registration = await api.mcp.registerServer({
    name: "claudepp_example_title",
    version: "0.1.1",
    tools: [{
      name: "set_session_title",
      description: "Change a Desktop session title only after an explicit user request.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          title: { type: "string" },
        },
        required: ["session_id", "title"],
        additionalProperties: false,
      },
      async handler(input, context) {
        api.log.info("Session title request", {
          callerSessionId: context.callerSessionId,
          targetSessionId: input.session_id,
        });
        const updated = await api.claude.sessionTitles.setTitle(input.session_id, input.title, context);
        return {
          content: [{ type: "text", text: `Renamed session ${updated.sessionId}.` }],
        };
      },
    }],
  });
}

async function stop() {
  const activeRegistration = registration;
  registration = undefined;
  await activeRegistration?.unregister();
}

module.exports = { start, stop };
```

`registerServer` accepts lowercase server and tool names made from letters, digits, `_`, and `-`. Server names must
start with `claudepp_`; every server needs at least one tool, and every tool needs an object JSON Schema. Tool results
contain MCP text content. The read-only handler context identifies the caller session for auditing; it does not select
the title target. A title target always comes from the explicit `sessionId` argument.

`context.callerSessionId` is Desktop's internal manager key. Pass the unchanged context to `setTitle`; Runtime first
reads that caller's raw DDK session record and compares its `cliSessionId` with the explicit target. A match routes to
the bound `local_*` key only after the alias remains unique and public `getSession(...)` confirms that the mapped key
is still live. Runtime never treats a raw record as update authority or substitutes the current session for an
unrelated or misspelled ID.

The registration is a revocable lease. Call `unregister()` during `stop()` even though Claude++ also revokes all
registrations when the owning Main API lease is disposed. Revocation immediately makes retained handlers and API
references reject; active Desktop sessions then reconcile through their normal idle or post-turn path.

For one Desktop process, the first accepted server structure is immutable: server name and version plus tool names,
descriptions, and input schemas cannot change after unregister, disable, or hot reload. A same-owner hot reload may
replace handler functions only when that complete structure is identical. Existing SDK handlers dynamically resolve
the current active handler, so do not retain or call a handler from a previous Tweak lease.

`setTitle` trims both arguments and first accepts an exact Desktop manager key. Otherwise it correlates a Claude Code
CLI UUID through the DDK manager's raw `sessions` Map, checking the caller-bound record first and then requiring a
unique process-wide match. The mapped key must still resolve through public `getSession(...)` before Runtime updates
it. It limits the title to 200 UTF-16 code units, uses Desktop's user-title update path, and verifies an exact read-back
before resolving. Unknown and ambiguous aliases are rejected. It can update the current session or another session
known to the same Desktop process. The MCP injection itself writes no `~/.claude.json`, project
`.mcp.json`, Claude `settings.json`, or managed MCP block. A successful title change does use Desktop's normal session
persistence path so the title survives restart.

These APIs support Claude Desktop only; they do not add tools to terminal-launched Claude Code. The reference Claude
Session Title Tweak `0.1.2` requires Runtime `0.2.9` for raw-record UUID correlation. Runtime is locked to explicitly
listed private Desktop builds, including module hashes and runtime shapes. A version, hash, or shape mismatch fails
closed: Claude continues to run, no server is injected, and Claude++ does not fall back to a configuration write or
another private patch.

This is an approved difference from Codex++. Codex++ declares external `command`/`args`/`env` servers in
`manifest.mcp` and synchronizes a managed block into `~/.codex/config.toml`. To meet Claude++'s no-configuration-write
requirement, Claude++ instead hosts SDK handlers in process and gives each Main Tweak a revocable registration lease.
The tradeoff is Desktop-only support and maintenance whenever the private Desktop boundary changes.

The independent [Claude Session Title Tweak](https://github.com/kpkhxlgy0/claude-session-title) is a complete example
of this pattern.

## Claude Code settings capability

Use this capability only when a Main-capable Tweak must manage one or more known Claude Code user-setting leaves. It does not provide general file access.

The permission and declaration are inseparable:

```json
{
  "scope": "both",
  "permissions": [
    "ipc",
    "settings",
    "claude-code-settings"
  ],
  "claudeCodeSettings": {
    "paths": [
      "skillOverrides.claude-api"
    ]
  }
}
```

Rules:

- `scope` must be `"main"` or `"both"`; Renderer-only Tweaks cannot request this capability.
- `claude-code-settings` without `claudeCodeSettings`, or a declaration without the permission, is invalid.
- `paths` must contain 1 to 64 unique dotted paths.
- Each path is limited to 256 characters and contains only identifier-like segments using letters, digits, `_`, or `-`.
- `__proto__`, `prototype`, and `constructor` segments are rejected.
- Parent/child overlap is rejected. Declaring `skillOverrides` together with `skillOverrides.claude-api` is invalid.

## Main-only API

A valid Main lease exposes:

```ts
interface ClaudeCodeSettingsApi {
  read(path: string): ClaudeCodeSettingsRead;
  write(
    path: string,
    value: ClaudeCodeSettingsJsonValue,
    expectedRevision: string,
  ): ClaudeCodeSettingsRead;
  remove(path: string, expectedRevision: string): ClaudeCodeSettingsRead;
}

interface ClaudeCodeSettingsRead {
  exists: boolean;
  value?: ClaudeCodeSettingsJsonValue;
  revision: string;
}
```

Renderer leases never expose `api.claudeCodeSettings`. A `scope: "both"` Tweak should register namespaced handlers in Main through `api.ipc.handle(...)`, then call those handlers from its Renderer Settings page through `api.ipc.invoke(...)`.

Every operation must use a path exactly equal to one manifest entry. Declaring `skillOverrides.claude-api` does not permit access to:

- its parent: `skillOverrides`;
- its child: `skillOverrides.claude-api.extra`;
- its sibling: `skillOverrides.doctor`.

## Revision-guarded mutation

Read immediately before mutation and pass the returned whole-file revision:

```js
const path = "skillOverrides.claude-api";
const current = api.claudeCodeSettings.read(path);
const updated = api.claudeCodeSettings.write(path, "off", current.revision);
```

To restore an originally missing leaf:

```js
const current = api.claudeCodeSettings.read(path);
const updated = api.claudeCodeSettings.remove(path, current.revision);
```

A missing settings file uses the revision `missing:v1`. Existing files use `sha256:<digest>`, calculated from the complete original file bytes. If any writer changes the file after the read, `write` or `remove` rejects the stale revision instead of replacing the file. Reload and ask the user to retry; do not silently overwrite the external change.

Mutations parse the full JSON object, clone it, alter only the declared leaf, write a unique sibling staging file, check the revision again, and atomically rename the staging file over the target. Unrelated settings are preserved semantically, though formatting is normalized when a change is written.

Node's standard filesystem APIs do not provide cross-process compare-and-swap. An arbitrary external writer can still race the small interval between the final revision check and atomic rename. Tweak UI and documentation must not describe the operation as absolutely race-free.

## Data and file validation

The API accepts JSON-compatible values only. It rejects non-finite numbers, circular references, non-plain object prototypes, and unsafe object keys. Reads and writes also reject:

- malformed JSON;
- array or primitive document roots;
- a non-object intermediate segment;
- a symbolic-link `settings.json`.

A missing file is treated as an empty object. A no-op remove does not create the file. Removing a leaf conservatively retains empty parent objects.

The default file is `~/.claude/settings.json`. If `CLAUDE_CONFIG_DIR` is set, the API targets `settings.json` under that redirected Claude user directory.

## Shared product scope

Claude Desktop and terminal Claude Code share user settings by default. A Tweak that writes this file must describe that shared scope in its Settings page and README. This API does not create a Desktop-only settings layer.

Higher-precedence command-line, local-project, project, or managed settings may change the effective result. Do not use `CLAUDE_CONFIG_DIR` as a single-setting isolation mechanism: it redirects the entire Claude user directory, including authentication, plugins, user skills, agents, memory, and settings.

## Recovery-state pattern

For a reversible override:

1. Read the leaf and save whether it exists plus its value in `api.storage`.
2. Persist that recovery record before writing the override.
3. Mark the record active only after the settings write succeeds.
4. On restore, read again and require the current value to still match the Tweak's override, or to already equal the saved original.
5. Refuse to overwrite an unexpected external value; offer a separate action that clears only the management record.
6. Restore before the user globally disables or uninstalls the Tweak.

Installing or loading a Tweak should not apply a user-setting override unless its documented purpose explicitly requires automatic mutation. Prefer an explicit Settings-page save action.

## Lease lifetime and trust boundary

All retained capability references reject calls after their Main lease is disposed. Do not cache them across reloads.

Main Tweaks are trusted local Node.js code. Manifest permissions constrain the APIs supported and supplied by Claude++; they are not an operating-system sandbox against malicious Main Tweak code.
