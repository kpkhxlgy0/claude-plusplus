# Windows mirror cleanup validation

## Scope and reference

Ported `packages/installer/src/windows-mirror-cleanup.ts` from Codex++ 1.0.10 commit `513d55c6531de950a7ea638930bf7b8c032576de`. Adaptations are the Claude package family, persisted `managedAppRoot`, Claude/Electron/Node process identities, and an optional local-app-data root honoring the existing injectable install paths. No Claude counterpart of the Codex sandbox-service exception exists, so that exception is omitted.

Both successful installation branches now invoke protected cleanup after state, CLI/managed launchers, shortcut, and applicable configuration persistence. Current watcher maintenance reaches cleanup before returning. Repair continues to delegate to install; self-update continues to invoke install. Removed the old all-noncurrent recursive-force helper. The CLI still accepts `--cleanup-all-old` and uses the same protected cleanup. Updated README CLI and installation-boundary descriptions. Installer version and its two loader-version assertions were changed to 0.3.11 at the parent release task's request.

## Red and green evidence

- Before implementation: `node --import tsx --test --test-name-pattern 'explicit all-old cleanup preserves|automatically cleans unused|cleanup process failure' packages/installer/test/commands.test.ts` failed all 9 selected cases. Unknown directories were deleted, ordinary successful paths retained obsolete mirrors, and process failures did not protect mirrors or emit the required warning.
- After implementation: the same selected command passed all 9 cases.
- Initial native script run: 24 passed, 1 non-Windows no-op case skipped, 0 failed.
- Final directly related regression command: `node --import tsx --test packages/installer/test/windows-mirror-cleanup.test.ts packages/installer/test/commands.test.ts packages/installer/test/windows-store-mirror.test.ts packages/installer/test/windows-cleanup.test.ts packages/installer/test/windows-launcher.test.ts` — 104 total, 103 passed, 1 platform skip, 0 failed; exit 0; 36.5 seconds.
- `npm run build --workspace @claude-plusplus/installer` — passed, TypeScript exit 0.
- `git diff --check` — passed. Final diff inspection found no unrelated source refactors or removed valid comments.

Native fixtures cover strict version/family/architecture/publisher selection; current/newer/unknown/used retention; executable and command-line use; missing process metadata and process-query errors; state mismatch and state changes during or between removals; unsafe paths; root/target/descendant junctions and a junction appearing during inspection; deletion refusal; dry run; literal quoting/wildcards; missing current/state paths; and wrapper spawn/JSON/result-validation failures. Process inventory is isolated at the OS subprocess boundary in installation cleanup tests, while PowerShell validation and deletion run against real temporary directories.

## Limits and handoff

No real Claude installation state or mirror was changed by this implementation task, and no commit, push, release, package, or scheduled task operation was performed. Temporary fixtures use the OS temporary directory and remove themselves; no ad-hoc task scratch artifacts remain. Parent-owned release metadata and unrelated concurrent changes were preserved. The parent release task owns independent review, the complete repository test suite, packaging, publication, and any explicitly authorized real mirror cleanup.

As in Codex++, incomplete process/path/state inspection retains old mirrors and warns. Native PowerShell validation narrows deletion immediately before execution but does not provide an atomic filesystem/process snapshot; concurrently changing external state may leave mirrors behind. No additional cleanup bypass or background service is introduced.

## Parent release acceptance

- Independent reviewer examined the complete diff and new files against `d5b312587486b3c6a3efd7f5a5cf1eace5a6eb46`; no material findings remained.
- Full `npm test` (including all package builds): 807 total, 806 passed, one off-Windows no-op case skipped, zero failures; 157.3 seconds.
- `npm run package:windows` and `pwsh -NoProfile -File scripts/test-windows-package.ps1` passed. The ZIP contains 457 files and is 37,726,209 bytes. All workspace versions are 0.3.11. Cleanup/install outputs, Runtime, Loader, README, and third-party notices match the built files. Portable CLI version/status/Doctor and Tweak authoring succeeded without system Node/npm; external Junction sentinel retained; test profiles removed.
- ZIP SHA-256: `a37befeec0e755139cd75c0bd49fca2f95dbbac209ee486b4c34ee54903e1422`.
- Helper source SHA-256: `A2C116EC0473EFED829215F2F04977EBEDC0A6692DEDD63739B1EADC9B002023`.
- Install source SHA-256: `C18AD3495843E4EB05E4E9DBC9BF3AE9D22EE5ACC6A1F1615A6DC3EC0B548B92`.
- Native read-only preview planned 19 older mirrors and retained the current `Claude_4.23118.1.0_x64__pzs8sxrjxfjjc`, with no warnings (47.3 seconds).
- The built helper then removed those 19 authorized mirrors in 51.4 seconds, with no warnings. Final directory enumeration contains only the current mirror. Removed file sizes total 13,214,599,142 bytes (12.31 GiB), not an exclusive free-space measurement.
- Persisted state bytes and current ASAR bytes remained unchanged. State SHA-256: `CC7B3F6AFC9143A99864B432EFAD4664166F5AA9C238D57068F9DA7DCBBC0079`; ASAR SHA-256: `5D8E8AF639A0F41661A64EE3044B988DCC9B0C986099C8FF1C005A8707956D20`. Runtime and Tweaks remain present. No application install/restart was performed; the installed state still reports 0.3.10.
- Production Store remained reachable with six entries. No Store entry or Session Stats transport was changed.
- Packaging reported the same dependency warnings as 0.3.10 (six build-tree and four production-tree vulnerabilities); dependencies were not changed.
