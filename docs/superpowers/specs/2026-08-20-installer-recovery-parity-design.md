# Installer Recovery Parity Design

**Date:** 2026-08-20
**Status:** Approved for implementation planning
**Reference:** Installed Codex++ v1.0.0 source under `C:\Users\Admin\.codex-plusplus\source`

## Purpose

Bring Claude++ uninstall cleanup, Safe Mode, and ASAR drift diagnostics to Codex++ parity while preserving Claude++'s Windows managed-mirror architecture. The official Claude MSIX installation remains read-only; every destructive operation stays confined to Claude++-owned roots.

## Goals

- Attempt fixed-root removal of every Claude++ managed Store mirror during uninstall even when `state.json` is absent or invalid, and report any locked residual explicitly.
- Add explicit, queryable Safe Mode commands and make a Safe Mode change enter the existing Tweak reload lifecycle.
- Make cold-start Safe Mode omit the Renderer preload, matching Codex++ recovery behavior.
- Record trustworthy original and patched ASAR header hashes.
- Distinguish an intact patch, the original ASAR, unknown drift, an unreadable ASAR, and legacy untracked state.
- Rebuild an untrusted or legacy managed mirror from the official Claude package before accepting a new hash baseline.
- Preserve existing Tweak configuration, data, Watcher choice, and unknown configuration keys.

## Non-goals

- Modifying the official Claude MSIX or files under `WindowsApps`.
- Changing the approved opt-in Watcher policy.
- Adding macOS, Linux, arbitrary `--app`, or Codex native-host behavior.
- Changing Claude++'s approved in-process MCP design.
- Changing Loader fail-open behavior; that adjacent Codex++ difference is a separate future change.
- Adding whole-file ASAR hashing or code-signature verification. This design uses the Electron-relevant ASAR raw-header hash, as Codex++ does.

## Baseline and Reference Behavior

Claude++ currently deletes only the package directory derived from valid installer state. Missing or malformed state therefore leaves `%LOCALAPPDATA%\claude-plusplus\store-apps` behind. Codex++ always performs a fixed-root Windows cleanup independently of installer state.

Claude++ currently accepts only implicit Safe Mode enable and `--off`, changes only `config.json`, and registers its Renderer preload even when Safe Mode was active at startup. Codex++ supports `--on`, `--off`, and `--status`, rejects conflicting actions, touches a watched reload marker, and omits the preload on a Safe Mode cold start.

Claude++ currently treats valid Loader metadata as proof that the managed ASAR is ready. Codex++ records the original and patched ASAR raw-header SHA-256 values and compares the current header against both.

## Uninstall Cleanup

### Owned cleanup boundary

The state-independent managed mirror target is exactly `paths.storeApps`, resolved from `%LOCALAPPDATA%\claude-plusplus\store-apps`. It must never be constructed from a state field, command argument, wildcard, or unresolved environment-variable string.

Add a local-root assertion parallel to `assertClaudePlusPlusRoamingPath`. It resolves the configured `localRoot` and candidate with Windows path semantics and accepts the local root itself only when the caller explicitly requests it. Uninstall validates `paths.storeApps` as the exact expected child before invoking recursive removal.

### State handling

If a syntactically valid state points outside the managed mirror root, uninstall continues to fail closed before destructive work. This preserves the existing forged-state protection. Missing, malformed, or schema-invalid state does not prevent cleanup of the fixed `storeApps` root.

### Sequence

Uninstall performs these operations in order:

1. Resolve paths and read state.
2. Validate any state-derived managed package path, solely to reject forged external targets.
3. Validate the fixed roaming and local cleanup roots.
4. Remove Watcher tasks/script through the existing Watcher cleanup.
5. Attempt fixed-root `storeApps` cleanup independently of state.
6. Remove Runtime, state, and Start Menu shortcut.
7. With `--purge`, remove the roaming root, including Tweaks, Tweak data, configuration, and logs.

Managed Windows artifact cleanup follows Codex++'s best-effort policy: a locked optional artifact must not trigger deletion outside the dedicated root or cause a broader fallback. The CLI reports a warning when a fixed managed artifact could not be removed; it must not silently claim that artifact was removed.

`uninstallClaudePlusPlus` returns an uninstall result containing a `warnings` array. The CLI includes that array in its JSON result and writes each warning to stderr. `uninstalled` continues to mean the uninstall sequence ran to completion; `warnings` identifies any fixed managed artifact that remains and the exact safe path the user may retry after closing Claude++.

Ordinary uninstall continues to preserve `paths.tweaks` and `paths.tweakData`. Both ordinary uninstall and `--purge` remove `paths.storeApps`.

## Safe Mode

### CLI contract

The command accepts:

```text
claudeplusplus safe-mode
claudeplusplus safe-mode --on
claudeplusplus safe-mode --off
claudeplusplus safe-mode --status
```

No flag and `--on` both enable Safe Mode. Exactly one of `--on`, `--off`, or `--status` may be present. Duplicate or conflicting action flags are rejected. Unknown Safe Mode flags are rejected.

`--status` reads and returns the current state without creating or modifying `config.json`, the Tweaks directory, or a reload marker.

Enable and disable preserve every unknown root key, every unknown `claudePlusPlus` key, and all per-Tweak enabled flags. The existing atomic JSON writer remains the persistence mechanism.

The command returns JSON containing the resulting `safeMode` value, whether configuration changed, and whether a restart is required for complete Renderer application. Human-facing help explains that active Main Tweaks are reloaded immediately but a running Claude process should be restarted to guarantee the Renderer preload/CSP state matches the new mode.

### Reload signaling

After every enable or disable action, write `.claudepp-safe-mode-reload` directly under `paths.tweaks`, even when the requested value was already set. This matches Codex++'s reapply behavior and lets the command retrigger a failed or missed reload. The Tweaks directory is already watched by `TweakManager`; a root-level marker avoids dependence on Junction event propagation. Status never writes the marker.

The existing serialized reload path remains authoritative:

1. Stop all Main Tweaks and dispose their leases.
2. Clear Main Tweak module cache.
3. Re-read configuration and discover no Main Tweaks while Safe Mode is enabled.
4. Start the resulting set.
5. Broadcast the Renderer reload event.

No new parallel reload path or direct lease manipulation is introduced.

### Cold-start behavior

When Safe Mode is active at Runtime bootstrap, Claude++ does not install Renderer CSP compatibility and does not register the Claude++ Renderer preload for the default Session or later Sessions. Main-process management IPC and the Tweak directory watcher may remain active so CLI changes can be observed, but no Renderer management surface is exposed.

Entering Safe Mode from an already-running normal process stops active Tweaks, but the already-injected preload cannot be removed from existing Renderers. Leaving a cold-start Safe Mode process can restart Main Tweaks, but cannot inject the missing preload into existing Renderers. The CLI therefore reports restart guidance in both directions.

## ASAR Provenance

### Hash definition

Add a helper that calls `@electron/asar.getRawHeader(asarPath)`, hashes the returned `headerString` bytes with SHA-256, and returns a lowercase hexadecimal digest. This is the same identity used by Codex++ and Electron ASAR integrity metadata. Hash read failures are classified rather than swallowed as a match.

### State schema

Retain a discriminated union of state schemas:

- Schema 1: every currently required field, with no ASAR hashes.
- Schema 2: every schema 1 field plus required `originalAsarHash` and `patchedAsarHash`, each exactly 64 lowercase hexadecimal characters.

The state reader strictly validates both schemas and normalizes the optional Watcher value exactly as it does today. Schema 1 remains readable for backward compatibility; it is never silently promoted using an already-patched ASAR.

### Trust and rebuild algorithm

A reused managed mirror is trusted only when all of the following hold:

- State is schema 2.
- State package full name and version match the discovered official package.
- The current managed ASAR header is readable.
- Its hash equals `state.patchedAsarHash`.

The installer forces a fresh mirror copy from the official Claude package when any of these conditions is true:

- An explicit non-Watcher repair requested `force`.
- A reused mirror has no state, invalid state, or schema 1 state.
- A reused mirror belongs to the current package but its current ASAR is unreadable or does not match the schema 2 patched hash.
- A reused mirror and recorded package identity disagree.

The forced mirror operation uses the existing staging/backup/rename rollback pattern. It never writes to the official package. The fresh managed ASAR header is recorded as `originalAsarHash` before Loader injection. After successful injection and verification, the new header is recorded as `patchedAsarHash` and schema 2 state is written.

When a schema 2 mirror exactly matches the recorded patched hash but another component needs maintenance, reinjection preserves the recorded original hash. A repair must never set the original hash to the header of an already-patched ASAR.

### Current-install decision

Schema 2 installations are current only when the current ASAR hash equals `patchedAsarHash` in addition to the existing package, Loader version, fuse, and Runtime checks. Schema 1 installations remain usable for status compatibility but are not considered current by maintenance installation; the next install/repair rebuilds and migrates them.

### Status classification

For state-backed installations, status exposes an ASAR provenance value:

- `patched`: schema 2 and current hash equals `patchedAsarHash`.
- `original`: schema 2 and current hash equals `originalAsarHash` but not the patched hash.
- `drift`: schema 2 and current readable hash matches neither recorded value.
- `unreadable`: schema 2 but the ASAR cannot be read.
- `legacy`: schema 1, for which no trustworthy hashes exist.

With no valid state, provenance is `null`.

For backward compatibility, a schema 1 installation may remain `installed: true` when all existing Loader, Runtime, executable, and fuse checks pass. A schema 2 installation is `installed: true` only for `patched` provenance.

Doctor adds an `asar-hash` check:

- `patched`: OK, `matches patched`.
- `legacy`: informationally OK, `not recorded; run repair to establish provenance`.
- `original`: failed, `matches original; run repair`.
- `drift`: failed, `drift from original and patched`.
- `unreadable`: failed, `missing or unreadable`.
- no valid state: failed, `unavailable`.

The existing Loader and integrity-fuse checks remain separate so diagnostics identify the failing layer.

## Error Handling and Safety

- All mirror refresh and ASAR replacement operations retain staging, backup, rollback, and containment checks.
- A failed refresh or injection leaves the previous managed mirror restored when possible and does not write schema 2 state.
- A malformed legacy state is treated as missing; it is never a source of cleanup or hash authority.
- A valid but externally forged managed path causes uninstall to stop before cleanup.
- No failure may fall back to deleting `localRoot`, `%LOCALAPPDATA%`, a user profile, or an official app path.
- Locked-file and permission errors identify the exact Claude++ managed path and advise closing Claude++ before retrying.

## Test Requirements

Tests follow red-green-refactor and cover:

- Uninstall removes the entire fixed `storeApps` root with missing state, malformed state, ordinary uninstall, and purge.
- Ordinary uninstall preserves Tweaks/Tweak data; purge removes them.
- Forged external state still rejects before external deletion.
- Cleanup never targets an official Claude root or a sibling of `localRoot`.
- Safe Mode default/on/off/status, unknown/conflicting flags, no-write status, unknown-key preservation, unchanged per-Tweak flags, and reload marker creation.
- Runtime cold-start Safe Mode registers no Renderer preload for default or newly created Sessions.
- A watched Safe Mode marker drives the existing stop/dispose/re-discover/broadcast lifecycle.
- Raw-header SHA-256 calculation and validation of schema 1/schema 2 state.
- Fresh install records distinct original/patched hashes and the patched hash matches disk.
- Exact schema 2 patched state remains current without mirror rebuild.
- Original, drifted, unreadable, missing-state, and schema 1 mirrors force a clean refresh before a new schema 2 state is accepted.
- Status and Doctor return every provenance classification with the specified details.
- Failed forced refresh restores the previous mirror and does not overwrite state.

## Approved and Retained Differences from Codex++

- Claude++ continues to use a Windows version-keyed managed mirror and a disabled integrity fuse; Codex++ also patches other platform layouts and macOS integrity metadata.
- Claude++ Watcher remains explicitly opt-in.
- Claude++ uses structured JSON CLI output rather than Codex++'s colored prose.
- No Codex native-host, Owl, React, external MCP configuration, macOS, or Linux behavior is introduced.
