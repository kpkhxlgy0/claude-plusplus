# Claude++ local source installation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with the task ownership below. User approval to start already covers this implementation; do not add another approval checkpoint or commit.

**Goal:** Install a clone in place, add verified online Windows installation, and protect repositories across installation and updates.

**Architecture:** Preserve the current Windows managed-app mirror and portable-release format. Store the active source path in existing installation state; stable user-data launchers and all maintenance consumers follow that binding. Keep bootstrap filesystem guards self-contained for downloaded PowerShell text, and add an installer-side guard for self-update.

**Tech Stack:** PowerShell 5.1/7, Node.js 24+, TypeScript, existing Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-28-local-source-install-design.md`

## Constraints and review focus

- Watcher and automatic refresh stay off by default; maintain the separate explicit Watcher commands.
- No real app patching, scheduled-task registration, publication, dependency upgrades, or version changes during this task.
- Use native OS temp fixtures; protect exact deletion/move targets and never follow fixture links during cleanup.
- Test IEX from a wrapper inside a clone, different current directories, spaces/8.3 aliases, dependency failure, repeated installs, and package-install rollback.
- Test saved-source binding in both fresh and already-current maintenance paths; legacy state must continue to work.
- Test manual/forced/watcher update rejection before download and again before destructive transitions, including protected backups and nested repositories.
- Scope existing enabled-Watcher migration: refresh the owned command script/launcher without creating or enabling scheduled tasks.

## Task 1: PowerShell bootstrap (worker owns)

Files: `install.ps1`, `test/install-script.test.mjs` (and a new bootstrap test under `test/` if useful).

- [x] Establish behavioral failures for local in-place installation, IEX online entry, and protected package destinations.
- [x] Detect source via `$PSCommandPath` and source markers. Build a local tree with system Node 24+/npm; preserve its lockfile on failure; run its own CLI with forwarded arguments.
- [x] For evaluated online text, resolve official latest stable metadata, require the exact Windows ZIP and checksum asset, verify SHA-256 before extraction, validate payload identity, and invoke the packaged CLI directly rather than an older downloaded installer script.
- [x] Share guarded transactional managed-package installation between online and extracted-package paths; retain old data and restore the old source when maintenance fails.
- [x] Run bootstrap tests under available PowerShell engines with network/build/app side effects stubbed.

## Task 2: Persisted source and Node binding (worker owns)

Files: installer `state.ts`, `paths.ts`, `commands/install.ts`, `watcher.ts`, related new launcher helper; runtime `main.ts`, `management-ipc.ts` and maintenance execution helpers if required; associated tests.

Interface: installation state gains optional `sourceRoot: string`; legacy states resolve the existing managed path. `resolveClaudePlusPlusPaths()` returns that persisted active source. Install uses the actual executing CLI source, not the previous state root, and writes the binding in both install branches. Self-update consumes this through existing `paths.sourceRoot`; its file belongs to Task 3.

- [x] Establish failures for fresh/current install binding, legacy state fallback, local-source Settings maintenance, and explicit Watcher launcher resolution.
- [x] Generate `<roamingRoot>/bin/claudeplusplus.cmd` bound to recorded Node + compiled CLI; preserve arguments. Update an already-enabled Watcher's owned script without registering tasks.
- [x] Route runtime Settings and updater source selection to the recorded root; use recorded Node when a checkout lacks a bundled executable. Preserve disabled defaults.
- [x] Run targeted installer/runtime binding and Watcher regressions.

## Task 3: Protected self-update (worker owns)

Files: `packages/installer/src/commands/self-update.ts`, new `source-replacement.ts`, `packages/installer/test/self-update.test.ts` / new safety test.

Interface: `assertSafeSourceReplacement(...targets: string[]): void` rejects protected destructive targets. Current public selfUpdate options/dependencies remain compatible.

- [x] Establish failures for Git/linked/unknown current and previous paths, force bypass, and rollback protection.
- [x] Check targets before downloading or making work directories and immediately before source replacement/rollback. Watcher refusal reports disabled so its separate repair command may continue; manual refusal explains Git + local install maintenance.
- [x] Preserve verified official/custom managed archive updates and rollback tests.
- [x] Run focused updater tests; no live source mutation.

## Task 4: Integration and verification (primary owns)

- [x] Update README/architecture documentation to explain local, extracted-package, and online entry points and preserved Watcher policy.
- [x] Review shared state and launcher contracts across tasks; independently review the finished diff and repair material findings.
- [x] Run the complete `npm test` (includes build), syntax/whitespace checks, and packaging-relevant checks appropriate to the changed files.
- [x] Record actual test results and limitations under `docs/superpowers/validation/`; leave changes uncommitted and clean up task scratch files.
