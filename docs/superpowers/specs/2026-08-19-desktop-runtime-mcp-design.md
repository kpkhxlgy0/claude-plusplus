# Claude Desktop Runtime MCP Design

## Goal

Add a Main-Tweak API that registers in-process MCP servers in Claude Desktop without writing Claude MCP or settings
configuration. Use that API from an independent `D:\Unity\claude-session-title` Tweak whose
`set_session_title(session_id, title)` tool can rename the current session or any other session known to the same
Claude Desktop process.

## Approved scope

- Claude Desktop Code sessions only. Terminal-launched Claude Code processes are out of scope.
- The MCP is injected in memory. Claude++ must not write `~/.claude.json`, `.mcp.json`, `settings.json`, or an MCP
  managed block, and must not patch `app.asar`.
- No `PreToolUse` hook and no Renderer route inference are used. The caller supplies `session_id` explicitly.
- The previous Renderer-only `renameCurrentTitle(title)` design stays removed.
- Current, other, running, idle, and archived sessions are valid targets when they are known to the same Desktop
  session manager. Unknown IDs are rejected.
- The MCP tool may modify a known session other than its caller. The user explicitly accepted this authority model.
- The feature is implemented by an independent Tweak under `D:\Unity`, with reusable hosting capability in the
  Claude++ Runtime and SDK.

## Approved Codex++ divergence

Codex++ declares external `command`/`args`/`env` MCP servers in `manifest.mcp` and synchronizes them into
`~/.codex/config.toml`. Claude++ cannot use that architecture while satisfying the no-configuration-write requirement.

Claude++ therefore deliberately differs as follows:

1. It registers handler-backed, in-process SDK MCP servers at runtime instead of launching manifest-declared stdio
   servers.
2. Registration returns a revocable lease so Main Tweak stop, disable, and hot reload remove or deactivate tools.
3. A version-locked compatibility adapter observes Claude Desktop's private MCP assembly boundary. An unsupported
   Desktop build disables injection without blocking Claude startup.
4. The capability covers Claude Desktop only and carries higher maintenance cost when Desktop internals change.

The user approved this divergence after these effects were explained.

## User-visible MCP contract

The Session Title Tweak registers server `claudepp_session_title` with one tool:

```text
set_session_title(session_id: string, title: string)
```

Both fields are required. The handler:

1. trims `session_id` and `title`;
2. rejects an empty value;
3. rejects a title longer than 200 UTF-16 code units, matching the current Desktop behavior;
4. resolves `session_id` first as a Desktop session-manager key and then, when needed, as exactly one session record's
   Claude Code `cliSessionId` UUID; zero or multiple matches are rejected;
5. verifies the resolved target exists in Claude Desktop's session manager;
6. calls the normal Desktop update path with `titleSource: "user"`;
7. reads the target again and reports success only when the title matches exactly.

Claude exposes the current Code session's `cliSessionId` UUID inside the conversation, while Desktop keys its local
session manager by a separate `local_*` ID. Accepting both forms lets the required explicit argument use the UUID
Claude can actually supply without weakening the explicit-target contract.

`titleSource: "user"` is required because Desktop ignores an `auto` title update when a user title already exists.
The tool description tells Claude to call it only after the user explicitly requests a title change.

The MCP injection itself performs no configuration writes. A successful rename still uses Desktop's normal
persistence path, which saves Desktop session metadata and synchronizes the Claude Code transcript title. That write
is necessary for the title to survive a restart.

## Public SDK surface

Claude++ 0.2.6 adds two Main-only permissions:

- `mcp`: register in-process MCP servers.
- `claude-session-title-write`: update a known Desktop session title by explicit ID.

Renderer-only manifests requesting either permission are invalid.

The Main Tweak API gains:

```ts
interface TweakMcpApi {
  registerServer(server: TweakMcpServer): Promise<TweakMcpRegistration>;
}

interface TweakMcpRegistration {
  unregister(): Promise<void>;
}

interface ClaudeSessionTitlesApi {
  setTitle(sessionId: string, title: string): Promise<ClaudeSessionTitleUpdate>;
}

interface ClaudeApi {
  sessions?: ClaudeSessionsApi;
  sessionTitles?: ClaudeSessionTitlesApi;
}
```

`api.mcp` and `api.claude.sessionTitles` are absent without their respective permissions and are never exposed to a
Renderer lease. Tool handlers also receive a read-only caller context containing the Desktop caller session ID for
auditing; targeting still comes exclusively from the required tool argument.

Server and tool names use lowercase letters, digits, `_`, and `-`. Server names must start with `claudepp_`, tools are
unique within a server, and a server contains at least one tool. Each tool declares an object JSON Schema and returns
an MCP call result containing text content.

## Runtime registry and leases

The Runtime owns one process-wide registry grouped by Tweak ID. It rejects active server-name collisions. A Tweak API
lease tracks every registration it created. Disposing the lease:

1. revokes all handlers immediately;
2. removes their registry entries;
3. reconciles active sessions;
4. makes retained registration and title API references fail with a disposed error.

SDK MCP handlers do not close over a particular Tweak module instance. They resolve the current registry entry by
owner, server, and tool name for every call. This lets a hot-reloaded Tweak replace handler code without leaving the
old handler reachable from a running Claude query. Within one Desktop process, a server's schema and tool names are
immutable; a hot reload may replace handlers but must retain the same structural definition.

## Claude Desktop compatibility adapter

The private adapter is installed synchronously while Claude++ Runtime is loaded, before the original Claude Desktop
entry module. It selects one record by exact Desktop app-version string, wraps CommonJS module loading only long
enough to observe that record's four exact modules, and then restores the original loader.

Initial supported build: Claude Desktop app version `1.26832.0`. A second record supports app version `1.32885.1`,
which corresponds to Windows MSIX version `1.32885.1.0`.

| App version | Role | Bundled module | SHA-256 | Export slot |
|---|---|---|---|---|
| `1.26832.0` | MCP coordinator | `index.chunk-BaOfA05g.js` | `2ee867ed8d9a37bbd080e36fe70761a5c950ddf5f83eba34e3352e42da810b2b` | `et` |
| `1.26832.0` | Agent SDK factory | `index.chunk-Cqfh0Vpp.js` | `770123370be8db84e4750a2b593d9a3a0b9ed447c62708f3bc306c9f2a05994c` | `t` |
| `1.26832.0` | JSON Schema converter | `index.chunk-CPsVP-Uv.js` | `d8f3af544b3bb00203422c2a541b1d73f91c1bd85cd7e3ada90e116fdab919f7` | `t` |
| `1.26832.0` | CCD session manager | `index2.chunk-ZVJDHx_k.js` | `958cb9170271ab2f39db40b6ab0681a4e21e672327c51337800ba8c46221daba` | `claudeCodeSessionManager` |
| `1.32885.1` | MCP coordinator | `index2.chunk-CxKk9JLq.js` | `80811026e6adf46b5f6d8c9d95303908f34668cde1c7aa47b6404ac2a7d52ae3` | `Ct` |
| `1.32885.1` | Agent SDK factory | `index.chunk-mU2Ud8Q2.js` | `4599836d15846febabe6ba2d25ee5935d046b823174f4ce23ddb0670b54cf526` | `o` |
| `1.32885.1` | JSON Schema converter | `index2.chunk-BCdS6ADu.js` | `e2a496d092c2e328b186425660fbf36a39e36b3ecadb4d5c8a2fae0ae9ac0ec1` | `t` |
| `1.32885.1` | CCD session manager | `index2.chunk-Doi9IfNA.js` | `a7eaa600b023d2f7a589d0dd2437481b7ad8981ccea2b1f50101817cbbb584ff` | `n` |

The adapter requires both the hashes and runtime shapes:

- coordinator constructor prototype with `createAllServers`;
- Agent SDK `createSdkMcpServer` helper;
- JSON Schema-to-Zod-shape converter;
- selected session-manager export with `sessions`, `getSession`, `updateSession`, and `applyMcpServersIfIdle`.

The adapter does not normalize semver, match fuzzy basenames or source text, or fall back to another record. An exact
version, basename, hash, export slot, or runtime-shape mismatch fails closed before bindings are published.

Only after every check passes does it atomically wrap the exported coordinator's `createAllServers`. The wrapper first
awaits Desktop's original result, then adds a fresh SDK server instance per registered server and per Desktop session.
It never replaces an existing key. A collision or wrapper error returns the unmodified Desktop server record.

The adapter does not modify Anthropic's built-in `ccd_session_mgmt` provider or its telemetry, and it does not hook
`child_process.spawn` or append `--mcp-config`.

## Active-session reconciliation

Cold starts and warm resumes pass through the wrapped `createAllServers` path. Registry changes also reconcile the
session manager's active CCD sessions:

- an idle session calls Desktop's existing `applyMcpServersIfIdle` path immediately;
- a session with a running turn receives Desktop's normal `mcpServersDirty` marker and updates after the turn;
- a session without a live query needs no immediate update and receives the server on its next cold or warm start.

Every live query gets a distinct SDK MCP server instance because one MCP server instance owns one transport. Existing
Desktop MCP entries and Claude JSON MCP entries are preserved.

On removal, the managed entry is deleted only when its object identity matches the instance injected by Claude++.
This prevents a name collision from deleting an official or user server. Agent SDK `setMcpServers` then disconnects
the removed SDK transport. A revoked handler rejects calls even while a running turn is waiting for the deferred
server-list update.

## Failure and logging behavior

- Version, hash, or shape mismatch: restore the module loader, install no coordinator wrapper, log one unsupported
  build diagnostic, and keep Claude running.
- Registration collision or invalid definition: reject that Tweak registration without changing active sessions.
- Session reconciliation failure: log the session ID and operation, retain the previous server map, and do not block
  the Claude turn.
- Title validation, missing session, update failure, or read-back mismatch: return an MCP error result.
- Logs may include Tweak ID, server/tool name, caller session ID, target session ID, and success/failure. They must not
  include the title text, tokens, complete process arguments, or transcript contents.
- Safe Mode loads no Tweaks, so the inert compatibility wrapper has no registered server to inject.

## External Tweak layout

The independent project is `D:\Unity\claude-session-title` and follows the existing flat Claude++ Tweak convention:

- `manifest.json`
- `index.js`
- `package.json`
- `test/index.test.js`
- `test/manifest.test.js`
- English and Chinese README files
- Junction-based install/uninstall scripts and their tests
- compatibility validation script and tests
- `LICENSE`

Its manifest is Main-only, requires Claude++ `0.2.6`, and requests only `mcp` and
`claude-session-title-write`.

## Verification

Automated coverage must prove:

- SDK permissions and Main-only validation;
- registry validation, collision handling, immutable definitions, handler replacement, and revocation;
- exact compatibility probes and fail-closed mismatches;
- per-session SDK instance creation without overwriting Desktop servers;
- idle and running-session reconciliation and safe removal;
- current and other session title changes, CLI-UUID-to-Desktop-key resolution, all validation branches,
  `titleSource: "user"`, and read-back checks;
- Main API permission gating and retained-reference disposal;
- Tweak schema, explicit-ID forwarding, stop cleanup, and absence of filesystem APIs;
- the complete Claude++ and external Tweak test suites.

Controlled Desktop verification must cover new, warm-resumed, currently running, other, and archived sessions; Tweak
hot reload and disable; restart persistence; and unchanged hashes for `~/.claude.json`, project `.mcp.json`, and
Claude settings files.

## Out of scope

- Terminal Claude Code injection.
- A generic stdio MCP process manager.
- Writing or synchronizing Claude MCP configuration.
- Editing Claude Desktop ASAR contents.
- Patching the built-in `ccd_session_mgmt.set_session_title` implementation.
- Inferring a target session from a Renderer route or hook payload.
