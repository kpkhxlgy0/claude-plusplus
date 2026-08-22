# Claude++

Claude++ is a generic, unofficial Tweak platform for Claude Code Desktop on Windows. It was copied from
[Codex++](https://github.com/b-nnett/codex-plusplus) v1.0.0, retains the required attribution, and started with new
Git history rather than preserving Codex++ history as a fork. See `THIRD_PARTY_NOTICES.md` for exact provenance and
licensing.

Claude++ has four parts:

- SDK: host-neutral Tweak manifests, lifecycle types, storage, IPC, filesystem, and Settings APIs.
- Runtime: discovers and isolates Main and Renderer Tweaks in the managed Claude app.
- Loader: starts the external Runtime before the original Claude entry point.
- Installer and maintenance commands: install, status, doctor, repair, Safe Mode, launch, and uninstall.

Claude-specific workflows do not belong to Claude++ core. They are implemented by separately installed Tweaks that
may discover the capabilities of the current Claude Desktop build. Core Doctor checks the official installation,
state, managed app, Loader, Runtime, Settings bundle, config, public Store shape, optional Watcher, integrity fuse, and
Safe Mode. It does not test workflow-specific behavior.

## Install

Download and extract the Windows release, then run `install.ps1`. The release includes its own minimal Node.js runtime.
Stable and Prerelease channels do not require a system Node.js or npm installation. The Custom source channel builds
an explicitly trusted GitHub repository and requires system Node.js 24+.

To install from source, install Node.js 24 or newer with npm, clone the repository, and run:

```powershell
pwsh -File .\install.ps1
```

The script builds the checkout with npm before installing it. It does not download or install Node.js; when Node.js
24+ or npm is unavailable, it prints the requirement and exits without starting installation.

The command name used below is `claudeplusplus`. In an extracted or installed Windows package, its launcher is
`bin\claudeplusplus.cmd`.

```text
claudeplusplus install [--cleanup-all-old]
claudeplusplus watcher enable
claudeplusplus watcher disable
claudeplusplus watcher status
claudeplusplus update
claudeplusplus update --repo owner/repo --ref ref
claudeplusplus uninstall [--purge]
```

- `install` installs or maintains the managed Claude++ mirror. `--cleanup-all-old` removes every non-current managed
  mirror only after installation succeeds.
- `watcher enable|disable|status` explicitly manages the logon and five-minute auto-repair tasks.
- `update` follows the configured Stable channel. Add `--prerelease` for Prerelease, or use `--repo` with `--ref` for
  a trusted Custom source.
- `uninstall` preserves Tweak data by default. `--purge` removes the preserved Claude++ user data as well.

Watcher and automatic refresh are off by default. The Watcher is never installed by the normal install command, and
automatic refresh cannot be enabled until the Watcher is present.

## Settings and Tweaks

Claude++ adds Config, Tweaks, and Tweak Store pages to Claude Desktop Settings. The source checkout intentionally keeps
`store/index.json` as an empty schema-valid seed. The reviewed production registry is published separately from the
`gh-pages` branch and accepts only Tweaks pinned to an approved full Git commit. Private workflow Tweaks must be
distributed and installed separately. Start with the [Tweak author workflow](docs/tweaks/README.md). The
[advanced Claude capability guide](docs/tweak-authoring.md) covers startup environment, exact-path Claude Code
settings, in-process MCP, and session titles.

### Review-only update indicators

Claude++ starts a product metadata check when the `CLAUDE++` navigation group mounts or remounts and that mount is
visually eligible. A hidden mount defers the check until that mounted group first becomes visually visible. The
reviewed Store has a separate trigger: it warms on each visual false-to-true Settings transition. For an initially
visible Settings shell, both requests start before injector setup returns, after navigation is attached; navigation
waits for neither request.

When a newer Claude++ release is available, the `CLAUDE++` heading shows an `Update` review action. It opens the
current GitHub release URL, or the official
[`kpkhxlgy0/claude-plusplus` releases page](https://github.com/kpkhxlgy0/claude-plusplus/releases) when the result has
no release URL. Stable and Prerelease checks use `kpkhxlgy0/claude-plusplus`; Custom uses its saved repository. The
`Tweak Store` item shows the count of installed-version mismatches against the reviewed registry. Store memory
survives reopening Settings until manual `Refresh`, a successful Store installation, or Renderer restart.

Automatic checks download JSON metadata only. They never download a release archive or executable, install an
update, enable Watcher, or change automatic-refresh or other Settings state. Config's explicit `Check Now` publishes
through the same controller-owned product state as the automatic check and uses the same validity-aware advisory
writer, so it does not replace a present malformed, non-object, or unreadable config merely to cache a result. The
separate opt-in maintenance policy above remains unchanged.

The automatic Store warm attaches only a success continuation and has no local rejection handler, matching Codex++.
An explicit Store-page render catches a load failure, clears the Store badge, and renders the page's error and
`Refresh` state. The product `Update` click is likewise fire-and-forget with no local rejection handler; the automatic
product-check IPC does catch rejection and hides the action.

## Installation boundary

Claude++ creates and patches only a managed mirror of the official Claude app. It does not modify WindowsApps or the
Windows registry, and it does not install a localhost service or resident receiver. The Windows release contains its
own minimal command runtime, so users do not need to install Node.js or npm separately. No native-host component is
used. Normal install and maintenance retain every old managed mirror, matching Codex++. To remove all non-current
mirrors after a successful install, run `claudeplusplus install --cleanup-all-old`. Claude++ does not provide a
previous-version-only cleanup mode. Maintenance preserves config, Tweak Junctions, Tweak data, Safe Mode, enabled
flags, and old managed mirrors.

Claude and Claude Code are products of Anthropic. Claude++ is not affiliated with or endorsed by Anthropic.
