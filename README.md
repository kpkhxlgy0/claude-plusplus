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

To install the latest stable Windows release online:

```powershell
irm https://raw.githubusercontent.com/kpkhxlgy0/claude-plusplus/master/install.ps1 | iex
```

The online installer downloads the official Windows ZIP and its checksum, verifies SHA-256 before extraction, and
uses the release's bundled Node.js. Running the online command inside a clone still follows this download path.

To install from source, install Node.js 24 or newer with npm, clone the repository, and run:

```powershell
pwsh -File .\install.ps1
```

Running the saved script builds and installs that exact source tree, including local edits, without copying the
checkout or its Git metadata into another directory. The script locates the source beside itself, so its absolute
path also works from another working directory. Local `npm ci` failure stops installation and preserves the lockfile.
Dependencies may require network access; source installation does not download or install Node.js.

When Node.js 24+ or npm is unavailable, source installation prints the requirement and stops. A successful install
records its source directory and exact Node.js executable. CLI maintenance, Settings, and an already-enabled Watcher
follow that binding. Re-run `install.ps1` after moving the checkout or replacing Node.js.

Update a local Git checkout with Git and rerun its saved installer. Manual and automatic source updates refuse to
replace Git repositories, including with `--force`. Managed-package installation and updates also protect linked
destinations, unrelated nonempty directories, and previous-source backups. Existing configuration and Tweak data
remain in the Claude++ user-data directory.

The command name used below is `claudeplusplus`. In an extracted or installed Windows package, its launcher is
`bin\claudeplusplus.cmd`. After installation, a stable launcher at
`%APPDATA%\claude-plusplus\bin\claudeplusplus.cmd` targets the active source and Node.js executable for either mode.

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
`Refresh` state. The group-heading `Update` review click is likewise fire-and-forget with no local rejection handler;
the automatic product-check IPC does catch rejection and hides the action. Config's separate `Download Update` action
starts the installed updater explicitly and reports launch, download, verification, extraction, build, installation,
completion, or failure state in Settings. Downloads show a real percentage and progress bar only when the response
supplies a valid total size; otherwise Settings reports the actual bytes received without inventing a percentage.

## Installation boundary

Claude++ creates and patches only a managed mirror of the official Claude app. It does not modify WindowsApps or the
Windows registry, and it does not install a localhost service or resident receiver. The Windows release contains its
own minimal command runtime, so users do not need to install Node.js or npm separately. No native-host component is
used. Normal install and maintenance retain every old managed mirror, matching Codex++. To remove all non-current
mirrors after a successful install, run `claudeplusplus install --cleanup-all-old`. Claude++ does not provide a
previous-version-only cleanup mode. Maintenance preserves config, Tweak Junctions, Tweak data, Safe Mode, enabled
flags, and old managed mirrors.

Claude and Claude Code are products of Anthropic. Claude++ is not affiliated with or endorsed by Anthropic.
