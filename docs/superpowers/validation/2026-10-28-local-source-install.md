# Local source installation validation

Implementation scope: local checkout installation, verified online/extracted Windows package installation, persisted source/Node binding, and protected source updates. Version remains 0.3.6; this record does not represent a publication or a live application reinstall.

## Completed checks

- `npm run build` passed with Node.js 26.12.1 / npm 11.20.0 on Windows.
- Source binding task: 182 focused tests passed, including fresh/current maintenance, staging-failure preservation, legacy state fallback, Settings execution, explicit Watcher migration, owned-launcher uninstall cleanup, and real CMD execution with spaces/percent/exclamation/ampersand paths.
- Source update task: 38 focused tests passed with no skips. Regressions reproduced unsafe source replacement, an 8.3 home-alias bypass, and unavailable-root traversal before fixes. Coverage includes protected current/previous paths, pre-download refusal, force, Watcher status, rechecks, and rollback.
- Compiled updater integration against the actual local Git checkout used isolated state/config under native OS Temp. Persisted binding resolved to the checkout; forced manual update refused, forced Watcher update returned disabled, zero network calls occurred, and the checkout remained present.
- Independent review of source binding and updater protection found no material issues.
- Final integration review of bootstrap transactions and the completed source/update paths found no material issues.
- The first complete validation passed 753/753 tests and the rebuilt portable-package smoke. A subsequent real Chinese-path probe under code page 936 exposed a generated-launcher decoding bug; this was corrected and independently reviewed. The focused regression proves Chinese source/executable paths and arguments, original exit status, restored code page, and no extra console output.

## Final acceptance

- Final `npm test`: **754 passed, zero failed, zero skipped**. This includes the build and 70 combined bootstrap cases across Windows PowerShell 5.1 and PowerShell 7. `git diff --check` passed.
- The compiled Chinese-source-path probe returned exit 0 and `unicode-launcher-ok` under the actual Windows environment.
- `npm run package:windows` and `pwsh -NoProfile -File scripts/test-windows-package.ps1` passed. The isolated portable CLI ran without system Node/npm on PATH and passed version, status, Doctor, authoring, and external-junction cleanup checks.
- The final test-only package SHA-256 was `48da3d86e6f05a7f114c03bf18e0fb0765530dab56a9e1248e2c877e4c8ed11d`. Both pre-existing versioned ZIP/checksum artifacts were restored and independently hash-verified after validation; this test package was not published.
- The four recorded installed Claude++ state/config/runtime files remained unchanged. Temporary test profiles were removed; the primary cleaned its verification logs, probes, and backup copies after recording these results.
- Manifest versions and dependency lockfile are unchanged. All task changes remain uncommitted.

No installed Claude application, user settings, or scheduled tasks have been deliberately changed. Network/download/build/app boundaries are inert in bootstrap/update tests; the portable package smoke uses the existing dedicated isolated-profile harness.

## Dependency audit observation

The package build reported one high-severity production dependency finding. A read-only `npm audit --omit=dev --workspaces --include-workspace-root --json` identified the transitive `brace-expansion` dependency and its denial-of-service advisories (including [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)). Package manifests and the lockfile are unchanged by this task. Dependency remediation and exploitability analysis are outside this implementation scope; no automatic dependency fix was applied.

## Live local-source migration, 2026-10-28

The user subsequently authorized replacing the old installation and confirmed Claude had exited. The following checks concern the real installation, after the isolated acceptance above.

- The first invocation of `install.ps1` stopped before modifying the installed application: `Get-Command node -CommandType Application` returned both Scoop Node and the Codex bundled Node, and their paths were combined into one command. Both Node and npm discovery now select the first Application in PATH order. Ten new regression cases failed before the fix and passed after it, covering PowerShell 7 and Windows PowerShell 5.1, multiple Node/npm candidates, and failure of the first Node without silently falling back. The complete bootstrap test file passed **80/80**, with no failures or skips. The earlier 754-test full suite was not repeated for this two-line discovery fix.
- The real `install.ps1` completed dependency installation, all four workspace builds, and installation maintenance using the exact checkout at `<local checkout>`. Version remains 0.3.6. The existing trusted application mirror was reused; this was a migration of source binding/runtime, not a purge of user data or a fresh official-app installation.
- Installed state and the stable `%APPDATA%\claude-plusplus\bin\claudeplusplus.cmd` bind to that checkout and Scoop Node. All **four runtime files** match the checkout's freshly built files by SHA-256. The stable CLI's Doctor passed **12/12** checks; Watcher reports `none`, no tasks and no script, and auto-update remains false.
- Configuration was compared with the snapshot taken after Claude exited and was structurally unchanged immediately after installation. All **eight tweak junctions** retain their original targets. The earlier preparation backup's config differed only in the `claudePlusPlus` section before installation, so the post-exit snapshot was used for preservation checks.
- The asynchronous CLI launch acknowledgement alone did not produce a surviving process in the command runner. Invoking the installed packaged PowerShell launcher synchronously started the managed Claude process. Its window was responding, and new main/renderer logs confirmed Session Stats startup, renderer preload registration and Renderer Tweaks startup. Existing host-mapping/CSP compatibility warnings also appeared; individual session TPS or Settings UI interactions were not inspected.
- Before cleanup, the entire old `.git` and root `dist` were archived to `%USERPROFILE%\.claude-plusplus\backups\<verified legacy archive>.zip`, with an adjacent manifest. All **457 archived files** were re-read from the ZIP and SHA-256 checked. Archive SHA-256: `BAF08B7F81A6AFC2683CB3FE0A32014569FA48A53EE942B09C9E91F40457BC5C`. This preserves the old Codex snapshot refs and historical release packages.
- Read-only cleanup inventory identified the old `%USERPROFILE%\.claude-plusplus\source` and **14 non-current managed mirrors** totaling about **9.28 GiB in logical file size**. The mirrors' ownership markers matched their directory names and official source paths; no reparse points were found in these trees.
- **Cleanup remains incomplete.** The guarded deletion command was rejected before execution with `blocked by policy`, without a more specific reason. Read-only inspection confirmed the old Git objects have the ReadOnly attribute, so its deletion `-Force` is necessary. No alternative deletion path was attempted. The old source and mirrors are therefore retained; the active installation uses the new checkout. No commit, push or release was performed.
- Final read-only verification again passed 12 Doctor checks, found one responding managed Claude window, and confirmed all 15 mirrors (current plus 14 old) and the old source remain. The task's native-Temp preparation backups and logs were removed after recording these results; the verified archive and adjacent manifest remain as the deliberate recovery backup.

### User-authorized retry without deletion `-Force`

The user explicitly requested retrying the deletion without `-Force`. The guarded command was accepted and executed. Deleting the old source stopped on Windows' insufficient-access/hidden/system/read-only error; subsequent inspection found 387 read-only Git files. Before that error, 23 files covered by the archive manifest had been removed. The old source is therefore partially deleted and is no longer an intact checkout; the complete verified archive remains available for recovery.

The 14 previously inventoried non-current managed mirrors contained no read-only/hidden/system files. Their paths, ownership markers, link-free trees and absence of running executables were rechecked, then all 14 were successfully removed with `Remove-Item -LiteralPath ... -Recurse` and no deletion `-Force`. Only the current `Claude_3.6556.2.0_x64__pzs8sxrjxfjjc` managed mirror remains. Removed mirror contents totaled approximately 9.28 GiB in logical file size; physical disk recovery was not measured.

After this cleanup, Doctor still passed 12/12 checks, the managed Claude window remained responsive, the new source binding remained active, and the recovery ZIP hash still matched its manifest. The residual old source remains pending cleanup; no file attributes or permissions were changed to remove its read-only files. No additional temporary artifacts were created.

### Final cleanup confirmation

The user manually removed the residual old source and reported completion. A fresh read-only check confirmed both `%USERPROFILE%\.claude-plusplus\source` and `source.previous` are absent. Only the current managed application mirror remains. The active source is still `<local checkout>`, Doctor passes 12/12 checks, and one managed Claude window is responding. Watcher remains `none`, auto-update remains false, and the retained recovery archive still matches its SHA-256 manifest. The requested migration and old-installation cleanup are complete; the archive and its manifest are deliberately retained.
