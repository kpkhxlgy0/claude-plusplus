# Safe Windows Mirror Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Approval for the same Codex++ design is already recorded; do not add an approval checkpoint or commit in this implementation task.

**Goal:** Automatically remove only proven obsolete unused Windows mirrors after successful Claude++ maintenance.

**Architecture:** Port the published Codex++ PowerShell cleanup helper and preserve its fail-closed guards. Adapt package/state/process identities and route both install success branches through the helper; repair continues to delegate to install.

**Tech Stack:** TypeScript, Node.js test runner, native Windows PowerShell, OS temporary fixtures.

**Spec:** `docs/superpowers/specs/2026-11-10-windows-mirror-cleanup-design.md`

## Constraints and review focus

- Current, newer, unknown, foreign, linked, or in-use mirrors must survive, including with `--cleanup-all-old`.
- Cleanup failure must warn without invalidating or rolling back an install.
- Validate persisted `managedAppRoot`, exact managed root, paths, process inventory, and reparse points immediately before native deletion.
- Keep the 60-second process timeout and do not log private process details.
- Tests must avoid ambient process dependence and never operate on real installation state.

## Task 1: Protected cleanup and installation integration

Files: new `packages/installer/src/windows-mirror-cleanup.ts`, `commands/install.ts`, `windows-store-mirror.ts`, new `test/windows-mirror-cleanup.test.ts`, `test/commands.test.ts`.

- [x] Add failing behavior tests for automatic cleanup in fresh/current/watcher/repair paths, unknown mirror retention, and nonfatal inspection failures.
- [x] Run the tests against existing code and record the expected failures.
- [x] Port the native helper, adapting `managedAppRoot`, `Claude_` identity, and Claude/Electron/Node process names without the Codex-only sandbox exception.
- [x] Remove the unsafe all-noncurrent helper; call protected cleanup after successful persistence and before watcher returns.
- [x] Run native fixtures and directly related installation/repair/launcher/cleanup tests, then installer build.

## Task 2: Documentation and handoff

Files: `README.md`, this spec/plan, `docs/superpowers/validation/2026-11-10-windows-mirror-cleanup.md`.

- [x] Describe automatic protected cleanup and compatibility of `--cleanup-all-old`.
- [x] Inspect the final diff and comment preservation, record exact validation and remaining limitations.
- [x] Leave version changes, complete release suite, packaging, publication, and real cleanup to the parent task.
