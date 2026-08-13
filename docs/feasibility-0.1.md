# Claude++ 0.1 Feasibility Gate

Status: passed on the official Claude Desktop build listed below.

> Historical evidence only. This document records the 0.1 experiments that used `LocalSessions`, a private Claude
> host adapter, fixed build fingerprints, and fixed asset hashes. Those experiments are not part of the current
> public Claude++ architecture. Current Claude++ core is a generic four-part Tweak platform; Claude-specific
> workflows and compatibility discovery belong to external Tweaks.

## Verified Baseline

- Date: 2026-08-12
- Official Claude package: `Claude_1.26832.0.0_x64__pzs8sxrjxfjjc`
- Official Claude version: `1.26832.0.0`
- Automated tests: 58 passed
- Self-contained Windows package: starts with system Node.js and npm removed from `PATH`
- Production dependency audit: 0 vulnerabilities
- Official-package policy: Claude++ installs and patches only its managed mirror

## Historical Manual Gate

The removed `run-feasibility-check.ps1` script previously extracted the self-contained release, installed the managed
Claude++ mirror, installed the optional feasibility probe as a Junction, verified the official executable and
`app.asar` hashes, and launched Claude++. The steps below describe the historical acceptance result and are not
current instructions.

Expected result:

1. Claude++ opens independently from the official Claude package.
2. A bottom-right panel displays `Claude++ 0.1.0 · LocalSessions ready`.
3. Entering a workspace path and clicking `Create test session` checks Claude's stored workspace trust.
4. An untrusted workspace requires a second explicit `Trust workspace & create` click before Claude++ calls the
   official `LocalSessions.saveTrust` API.
5. The trusted workspace creates and opens one independent session titled `Claude++ feasibility check`.
6. The created session receives only the fixed harmless feasibility prompt shown by the probe source.

Use `-NoLaunch` to perform setup and integrity checks without opening Claude++.

## Historical Failure Evidence

The 0.1 investigation collected:

```powershell
& "$env:USERPROFILE\.claude-plusplus\source\bin\claudeplusplus.cmd" doctor
& "$env:USERPROFILE\.claude-plusplus\source\bin\claudeplusplus.cmd" debug
Get-Content "$env:APPDATA\claude-plusplus\log\main.log" -Tail 200
```

The investigation classified Loader startup, Renderer preload registration, `LocalSessions` capability discovery,
session creation, and `/epitaxy/<session-id>` navigation failures. Current version-specific discovery belongs to the
external Tweak rather than a Claude++ core adapter.

## Cleanup

The current generic Core Probe Junction can be removed with:

```powershell
pwsh -NoProfile -File .\scripts\remove-core-probe.ps1
```

Uninstall the managed Claude++ app while preserving Tweaks and Tweak data:

```powershell
& "$env:USERPROFILE\.claude-plusplus\source\bin\claudeplusplus.cmd" uninstall
```

Use `uninstall --purge` only when the Tweak and Tweak-data directories should also be removed.

## Manual Result

- Date: 2026-08-12
- Managed app launch: passed
- Renderer probe visible in sandboxed Claude windows: passed
- Workspace trust check and explicit approval: passed
- `LocalSessions.start`: passed
- Session title, prompt, and selected workspace mapping: passed
- `/epitaxy/<session-id>` navigation: passed
- Created session response: passed
- Official Claude package integrity: passed; the feasibility script verified the official executable and `app.asar`
  remained byte-for-byte unchanged

The real Claude windows used `sandbox=true` and `contextIsolation=true`. That evidence still informs the generic
Renderer Tweak loader, but the private Trust/session APIs and permissions described by the 0.1 experiment have been
removed from Claude++ core.
