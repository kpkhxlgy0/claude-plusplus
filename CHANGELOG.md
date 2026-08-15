# Changelog

All notable changes to Claude++ are documented here.

Claude++ uses semantic versioning for the Installer, Runtime, SDK, Loader, and Windows release package. Tweak authors
should also use semantic version tags so the manager can compare installed and available versions.

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
