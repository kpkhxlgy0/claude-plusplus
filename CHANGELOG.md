# Changelog

All notable changes to Claude++ are documented here.

Claude++ uses semantic versioning for the Installer, Runtime, SDK, Loader, and Windows release package. Tweak authors
should also use semantic version tags so the manager can compare installed and available versions.

## 0.3.0

Release notes: [docs/releases/0.3.0.md](docs/releases/0.3.0.md)

### Added

- Added the Windows-local `create-tweak`, `validate-tweak`, and `dev` workflow with runnable CommonJS scaffolds,
  SDK-backed validation, contained Junction links, watched validation, and command-local help.
- Added a complete Tweak authoring guide and materialized the Claude++ SDK in the portable Windows package so the
  packaged authoring commands work without an npm-published SDK.
- Added full Safe Mode `--on`, `--off`, and `--status` controls, plus managed-ASAR provenance in `status` and
  `doctor`.

### Changed

- Trust a managed mirror only when schema-2 provenance exists, its package identity agrees, and its current ASAR
  raw-header hash matches the recorded patched hash; rebuild legacy or untrusted mirrors from the official package.

### Fixed

- Roll back an uncommitted managed-mirror refresh when preparation or injection fails, and clean known managed
  mirrors during uninstall even when installer state is missing or malformed.
- Preserve unreadable or invalid Safe Mode configuration instead of replacing it, and omit Renderer preload/CSP
  registration on a Safe Mode cold start.

### Security

- Hardened Tweak entry and development-link handling against path escapes, unsafe or reserved names, broken links,
  marker redirection, and recursive replacement of user content.

## 0.2.9

Release notes: [docs/releases/0.2.9.md](docs/releases/0.2.9.md)

### Fixed

- Restored Claude Code UUID targeting on Claude Desktop `1.32885.1` by correlating the UUID through the DDK
  manager's raw session record, whose public `getSession(...)` snapshot omits `cliSessionId`.
- Kept exact Desktop keys authoritative, rejected duplicate UUID aliases, and validated a uniquely mapped target
  through `getSession(...)` before updating its title.
- Paired the correction with Claude Session Title `0.1.2`, which requires Runtime `0.2.9` while keeping the required
  `session_id` and `title` tool arguments unchanged.

## 0.2.8

Release notes: [docs/releases/0.2.8.md](docs/releases/0.2.8.md)

### Fixed

- Corrected the Claude Desktop `1.32885.1` compatibility record to bind the real CCD
  `claudeCodeSessionManager` instead of the similarly shaped cowork manager, so title lookups reach the manager that
  owns Desktop Code sessions.
- Kept Claude Session Title `0.1.1` compatible without changing its required `session_id` and `title` tool arguments
  or writing Claude MCP configuration.

## 0.2.7

Release notes: [docs/releases/0.2.7.md](docs/releases/0.2.7.md)

### Fixed

- Used each title tool call's bound Desktop `local_*` session ID to validate the Claude Code CLI UUID exposed in
  conversation, so an explicit current-session UUID reaches Desktop's actual title key.
- Resolved other explicit CLI UUID targets through `getSession(...)` snapshots instead of relying on private session
  Map values that can omit the alias at runtime.

## 0.2.6

Release notes: [docs/releases/0.2.6.md](docs/releases/0.2.6.md)

### Added

- Added Main-only `mcp` registration for handler-backed, in-process MCP servers in supported Claude Desktop builds.
- Added Main-only `claude-session-title-write` for updating a known Desktop session through an explicit session ID.
- Published the independent [Claude Session Title Tweak](https://github.com/kpkhxlgy0/claude-session-title) as the
  reference integration; it is Desktop-only and does not add terminal Claude Code support.

### Security

- Version-, hash-, and shape-locked the private Desktop adapter so unsupported builds fail closed without MCP
  configuration writes or another private fallback.
- Revoked MCP handlers and title APIs with their Main leases, rejected server collisions and structural changes for
  the lifetime of a Desktop process, and kept normal Desktop title persistence separate from MCP injection.

## 0.2.5

Release notes: [docs/releases/0.2.5.md](docs/releases/0.2.5.md)

### Added

- Added a Main-only, permission-gated `claude-code-settings` Tweak API restricted to exact manifest-declared paths.
- Added revision-guarded atomic read, write, and remove operations for Claude Code user settings.

### Security

- Rejected malformed settings, unsafe paths and values, incompatible intermediate structures, undeclared access, and stale revisions without replacing the target file.
- Revoked retained settings API references when their Main Tweak lease is disposed and documented the shared Desktop-plus-terminal scope of user settings.

## 0.2.4

Release notes: [docs/releases/0.2.4.md](docs/releases/0.2.4.md)

### Added

- Added a permission-gated, declarative `startup-environment` Tweak API with exact key ownership.
- Applied valid per-Tweak startup snapshots before Claude's original Main entry without loading Tweak JavaScript early.

### Security

- Failed closed on malformed, partial, incompatible, disabled, Safe Mode, and ownership-conflicting snapshots.
- Restored the incoming process environment before a Tweak-requested relaunch and revoked retained API references when
  their Main Tweak lease is disposed.

## 0.2.3

Release notes: [docs/releases/0.2.3.md](docs/releases/0.2.3.md)

### Added

- Added a permission-scoped session-reference resolver that returns only an unambiguous local file destination from
  the selected Claude response.

### Fixed

- Preserved source line and column fragments for Claude-native file-reference buttons without exposing transcript
  contents to Tweaks.
- Refused transcript reference recovery when its same-label link count differs from the visible Claude response.

## 0.2.2

Release notes: [docs/releases/0.2.2.md](docs/releases/0.2.2.md)

### Added

- Added a permission-scoped Claude Sessions API for resolving a session file and reading only its absolute workspace
  root.

### Fixed

- Restored Renderer Tweak evaluation on current Claude Desktop while composing Claude's own response-header policy
  listener.
- Kept Safe Mode from relaxing the Renderer Content Security Policy.
- Revoked retained Claude Sessions API references when their Renderer Tweak lease is disposed.

## 0.2.1

Release notes: [docs/releases/0.2.1.md](docs/releases/0.2.1.md)

### Fixed

- Fixed Main Tweak hot reload for Junction and symlink installations by clearing modules through their canonical
  filesystem paths.
- Prevented stale Tweak code and missing IPC handlers after a linked Tweak source changes while Claude++ is running.

## 0.2.0

Release notes: [docs/releases/0.2.0.md](docs/releases/0.2.0.md)

### Added

- Added a generic Tweak SDK and isolated Main/Renderer lifecycle on Claude Code Desktop for Windows.
- Added Config, Tweaks, and Tweak Store pages aligned with the Codex++ management experience.
- Added install, status, Doctor, repair, update, Safe Mode, launch, watcher, and uninstall commands.
- Added Stable, Prerelease, and explicitly trusted Custom update channels.
- Added a self-contained Windows release with a portable Node.js runtime.

### Changed

- Kept product-specific workflows outside Claude++ core as separately distributed Tweaks.
- Kept the public Tweak Store empty until entries have been reviewed and pinned to full Git commits.
- Made the Watcher and automatic refresh opt-in.

### Security

- Claude++ modifies only a managed mirror and leaves the official Claude package unchanged.
- Installation does not modify the Windows registry or install a localhost service.
- Tweak permissions, lifecycle failures, Settings rendering, and IPC registrations are isolated and validated.
