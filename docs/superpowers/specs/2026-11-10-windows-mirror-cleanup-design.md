# Safe Windows mirror cleanup

The user requested the same approved cleanup behavior after publishing Codex++ 1.0.10. Reference: `D:/Unity/codex-plusplus/codex-plusplus`, commit `513d55c6531de950a7ea638930bf7b8c032576de`, `packages/installer/src/windows-mirror-cleanup.ts` and its native fixture tests.

After a successful install or already-current maintenance, including watcher maintenance and repair through install, remove only immediate managed mirror directories with a recognized `Claude_<four-part-version>_(x64|x86|arm64)__<13-character-publisher>` name, the same architecture and publisher as the persisted current mirror, and a strictly older version. Keep current, newer, unknown, foreign, in-use, inaccessible, and linked mirrors. Keep accepting `--cleanup-all-old`, with the same protected behavior; it must not bypass these checks.

Port the Codex++ native PowerShell boundary: validate canonical absolute paths and all ancestor/descendant reparse points, re-read unchanged persisted state (`managedAppRoot` in Claude++), inspect fresh process inventory before each removal, and use `Remove-Item -LiteralPath -Recurse` without `-Force`. Failed or incomplete Claude/Electron/Node process inspection preserves the mirror. Do not expose process command lines in warnings. There is no Claude equivalent of the Codex packaged sandbox service exception, so no such exception is added.

Cleanup follows state, launcher, shortcut, and applicable configuration persistence. Failure is a nonfatal warning and cannot roll back a completed install. The native subprocess is hidden, bounded to 60 seconds, and returns structured results. The existing injectable `paths` are honored by passing their local-app-data root into the native boundary; its exact `claude-plusplus/store-apps` child remains mandatory.

Tests run the real script and native deletion against OS temporary fixtures, isolating only process inventory and deliberate failure/race boundaries. Do not patch real app installations, delete real mirrors, register tasks, or publish as part of implementation. Versioning, release packaging, and any live cleanup are owned by the parent release task.
