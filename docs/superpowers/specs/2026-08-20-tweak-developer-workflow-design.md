# Tweak Developer Workflow Design

**Date:** 2026-08-20
**Status:** Approved for implementation planning
**Reference:** Installed Codex++ v1.0.0 source under `C:\Users\Admin\.codex-plusplus\source`

## Purpose

Give Claude++ Tweak authors the same essential create, validate, link, watch, and documentation workflow available in Codex++, adapted to Claude++'s stricter manifest rules, Windows-only host, public Claude APIs, and in-process MCP model.

## Goals

- Add `create-tweak`, `validate-tweak`, and `dev` CLI commands with familiar Codex++ command shapes.
- Make the existing Claude++ SDK validator the single manifest-validation authority.
- Generate immediately runnable CommonJS examples for Renderer, Main, and both-process Tweaks.
- Provide a containment-checked Windows Junction workflow for local development.
- Validate on source changes and deterministically signal the existing Runtime reload watcher.
- Document the complete path from first scaffold through validation, local development, bundling, debugging, and distribution.
- Keep generated code limited to Claude++ public APIs and permissions.

## Non-goals

- Publishing `@claude-plusplus/sdk` to npm or another registry.
- Generating TypeScript, JSX, React, or bundler projects by default.
- Adding a graphical project wizard or Tweak Store publishing automation.
- Adding Codex-only Owl, React-fiber, native window/view/CDP/native-host APIs.
- Adding external stdio MCP declarations or writing Claude MCP configuration.
- Adding macOS/Linux development-link support in this Windows-only release.
- Changing Runtime lifecycle ordering or introducing a second Runtime watcher.

## CLI Surface

### Create

```text
claudeplusplus create-tweak <target>
  [--id <id>]
  [--name <display-name>]
  [--repo <owner/repo>]
  [--scope renderer|main|both]
  [--force]
```

The target argument is required. Unknown flags, missing option values, duplicate value options, and an invalid scope fail before files are written.

If the target does not exist, create it. If it exists, it must be empty and `--force` must be present. `--force` never overwrites a non-empty directory or an existing file.

Defaults derive from the target directory name:

- slug: lowercase target basename with unsupported runs replaced by `-`.
- id: `com.example.<slug>`.
- name: title-cased slug.
- repository: `example/<slug>`.
- version: `0.1.0`.
- description: `A Claude++ Tweak.`.
- scope: `both`.
- main: `index.js`.

Before any write, construct the complete manifest and pass it to `validateTweakManifest`. A generated manifest that fails SDK validation aborts without a partial project.

The command creates exactly:

```text
<target>/
  manifest.json
  index.js
  package.json
  README.md
```

### Validate

```text
claudeplusplus validate-tweak [target]
```

The default target is `.`. A target may be a Tweak directory or a manifest file. A directory resolves to `<target>/manifest.json`.

Validation performs these checks in order:

1. Target and manifest exist.
2. Manifest is valid JSON.
3. `@claude-plusplus/sdk.validateTweakManifest` succeeds.
4. Select explicit `manifest.main`, otherwise `index.js`, `index.cjs`, then `index.mjs`. An explicit entry must be project-relative, must not be drive-qualified on Windows, and must contain no `..` segment. Every accepted explicit or fallback entry must resolve canonically inside the canonical Tweak source directory, and its canonical target must be a regular file. Absolute entries, drive-qualified Windows entries, traversal entries, directories, and in-project Junction/symlink paths whose targets escape the project are validation errors.

All SDK errors and warnings are printed with their manifest paths. Missing entries are validation errors. Warnings do not fail the command. Any error causes a non-zero CLI exit through the existing top-level error path.

This containment rule means an out-of-tree build output cannot be referenced directly from `main`; authors must copy or bundle it into the Tweak project. Normal in-project files and hot reload behavior are unchanged.

### Dev

```text
claudeplusplus dev [target]
  [--name <link-name>]
  [--replace]
  [--no-watch]
```

The default target is `.`. Dev validates the source directory and entry before touching the live Tweaks directory.

The source directory may live anywhere the user explicitly selects, but it must resolve to an existing directory containing a valid Tweak. The default link name is `manifest.id`. An explicit `--name` must use the same character set as a manifest id: letters, numbers, dots, underscores, and dashes. It cannot be empty, `.` or `..`, contain a path separator, resolve anywhere except an immediate child of `paths.tweaks`, or equal the reserved `.claudepp-dev-reload` basename in any letter case. The same reservation applies when the default manifest id supplies the link name, and it is checked before any Tweaks-root or link mutation.

On Windows, the link is a directory Junction from `<paths.tweaks>/<link-name>` to the absolute source directory.

Collision behavior:

- An existing Junction to the same source is idempotent.
- An existing Junction to another source requires `--replace`.
- `--replace` repeats the full contained, non-broken Junction check immediately before using nonrecursive `unlink` on that directory entry, then creates the new Junction. Recursive forced removal and directory removal are not used.
- A real file or directory is never removed or replaced.
- A malformed or broken existing reparse target is rejected rather than followed. A valid Junction target outside `paths.tweaks` is expected because it is the explicitly selected source project; containment applies to the live link path, not to that source.

Write `.claudepp-dev-reload` directly under `paths.tweaks`. This root-level marker deliberately differs from Codex++'s marker-inside-link design so Windows reload signaling does not depend on Junction event propagation. Before changing a link, preflight an existing marker with `lstat`: it must be absent or a single-link regular file. Directories, reparse points, hard-linked files, and unknown objects are rejected without changing the link. Marker refresh repeats that preflight, writes the timestamp to an unpredictable same-directory temporary file opened exclusively, and atomically renames the temporary entry over the marker. It never opens the marker for writing, so a pre-existing or post-preflight symlink/hardlink target is not followed. Temporary entries are removed nonrecursively after success or failure. The cost is one additional marker `lstat` before link mutation plus an exclusive temporary-file create/write/close and same-directory rename per successful marker refresh; normal Junction and reload behavior is unchanged.

Without `--no-watch`, recursively watch the source directory. Ignore `node_modules` and changes to generated reload-marker names. Debounce events by 100 milliseconds. For each settled change:

1. Re-read and validate the manifest and entry.
2. On success, update the root-level reload marker and print a valid timestamp/path message.
3. On failure, print the validation failure and do not update the root marker.

The existing Runtime watcher retains Chokidar's default `followSymlinks: true`, matching Codex++. Consequently, a source edit under a development Junction may also reach Runtime directly before or independently of this 100-millisecond validation loop. The root marker is a deterministic supplemental success signal, not a validation gate for Runtime reload. An invalid edit does not write the marker, but it may still cause Runtime to stop the old Tweak and fail to rediscover the edited Tweak. Duplicate direct/marker events normally debounce together but are not guaranteed to do so. This Codex++ parity tradeoff was explicitly approved on 2026-08-21.

SIGINT and SIGTERM cancel the pending timer, close the watcher, remove installed signal handlers, and resolve normally. A source-watcher error uses the same idempotent cleanup path and then fails the command. The command does not delete the development Junction on exit.

## Generated Project

### Manifest permissions

Permission defaults match only APIs used by the generated template:

- `renderer`: `settings`.
- `main`: `ipc`.
- `both`: `settings`, `ipc`.

No template requests `network`, `claude-sessions`, startup environment, Claude Code settings, MCP, or session-title write access without demonstrating and documenting that capability.

### CommonJS templates

Renderer scope registers a Settings page and renders text using DOM APIs.

Main scope logs startup and registers the local `ping` IPC handler; Claude++ Runtime adds the Tweak-id namespace.

Both scope branches on `api.process`: Main registers local channel `ping`; Renderer registers a Settings page with a button that invokes the same local channel. Every template provides a `stop()` location and retains cleanup handles where an API requires explicit disposal.

Templates use `module.exports`; they contain no raw TypeScript, ESM import/export, Codex global, Owl, React, native-host, or external MCP configuration.

### package.json

The generated package is private, CommonJS, and contains:

```json
{
  "scripts": {
    "validate": "claudeplusplus validate-tweak .",
    "dev": "claudeplusplus dev ."
  }
}
```

The official npm registry currently returns E404 for `@claude-plusplus/sdk`. The scaffold therefore does not generate an unresolvable npm dependency. Plain JavaScript Tweaks run without the SDK package. TypeScript documentation explains how to install the SDK package from the locally installed Claude++ source until a separate publication project is approved.

### README

The generated README describes:

- Manifest and entry files.
- `npm run validate`.
- `npm run dev` and `--no-watch`.
- The live `%APPDATA%\claude-plusplus\tweaks` destination.
- Restart guidance if Renderer changes cannot apply to an existing Claude Session.
- The requirement to clean resources in `stop()`.

## Shared Validation and Packaging

The installer package adds `@claude-plusplus/sdk` as a workspace dependency and imports `validateTweakManifest` from it. No duplicate validator is introduced.

The portable Windows package cannot retain workspace Junctions in a ZIP. Packaging therefore materializes `@claude-plusplus/sdk` as a real directory under the packaged `node_modules/@claude-plusplus/sdk`, containing its package metadata and built `dist`. Other workspace links continue to be removed as today.

The package smoke test verifies that the packaged CLI can run `create-tweak`, `validate-tweak`, and one-shot `dev --no-watch` using the portable Node runtime without system Node/npm resolution. The smoke harness redirects `APPDATA`, `LOCALAPPDATA`, and `USERPROFILE` to a temporary test root before `dev`, so it cannot create a Junction or marker in the user's live Claude++ directories.

## Documentation Structure

Retain `docs/tweak-authoring.md` as the Claude-specific advanced capability guide and add:

```text
docs/tweaks/
  README.md
  getting-started.md
  manifest.md
  runtime-lifecycle.md
  api-reference.md
  typescript-and-bundling.md
  distribution-debugging.md
```

The documentation index links every page and the top-level README links the index.

Content requirements:

- Getting Started: directory layout, create/validate/dev commands, all three process scopes, entry resolution.
- Manifest: every SDK field, Claude-only permission/declaration coupling, `minRuntime`, Store metadata, and explicit scope guidance.
- Runtime lifecycle: Main/Renderer loading, start/stop, lease revocation, hot reload order, cleanup checklist, storage locations, Safe Mode.
- API reference: public SDK interfaces grouped by common, Renderer, Main, and permission-gated capability.
- TypeScript and bundling: local SDK source installation, browser-vs-Node esbuild targets, CommonJS output, both-process constraints.
- Distribution/debugging: release checks, reviewed Store commits, log locations, DevTools/Main logs, compatibility and cleanup rules.
- Advanced guide: retain the existing Claude Code settings, in-process MCP, and session-title material; add a startup-environment section grounded in Runtime behavior and the production GPT Context Window Tweak, then link rather than duplicate those advanced capabilities elsewhere.

Packaging copies the complete `docs/tweaks` directory in addition to `docs/tweak-authoring.md`.

## Error Handling and Security

- File writes occur only after manifest and target preflight succeeds.
- Create never overwrites non-empty content.
- Dev source targets are resolved and validated as Tweak directories; live link destinations are containment-checked before removal or creation.
- Validation accepts an entry only when its canonical target is a regular file inside the canonical Tweak source directory. Explicit absolute, drive-qualified Windows, and traversal entries and in-project Junction/symlink escapes fail before dev linking.
- `--replace` applies only to a contained reparse point and removes its directory entry with nonrecursive `unlink`; it never uses recursive forced removal or removes a real directory.
- The reload-marker basename is reserved case-insensitively. Marker preflight rejects reparse points, directories, multi-link regular files, and unknown objects before link mutation, while exclusive same-directory temporary writes plus atomic replacement avoid following marker targets.
- Source validation errors never cause a live marker update.
- Source validation is advisory rather than a Runtime reload barrier because the approved Runtime watcher continues following Junctions as Codex++ does.
- The CLI does not execute Tweak source during create, validation, or link setup.
- Main Tweaks remain trusted local Node.js code; manifest permissions constrain Claude++ API leases but are not an operating-system sandbox.
- Documentation does not imply that Renderer Tweaks have Node `require`, that external MCP configuration is supported, or that private Claude internals are stable public APIs.

The supported threat boundary is trusted same-user local development. Full checks are repeated immediately before path-based Junction deletion, but a hostile same-user process that atomically swaps a regular file or different link into that final path-based deletion instant is outside the guarantee. Eliminating that narrow race would require a native Windows handle-based implementation and is not part of this plan. The atomic marker replacement still never writes through a swapped target.

## Test Requirements

Tests follow red-green-refactor and cover:

- Argument parsing for every command, option, default, missing value, duplicate option, unknown flag, and invalid scope.
- Create output for Renderer, Main, and both scopes, including exact permissions and executable templates.
- Default metadata derivation and explicit metadata overrides.
- Refusal of existing files, non-empty directories, and empty directories without `--force`.
- No partial scaffold when generated manifest validation fails.
- Validation of a generated Tweak, a direct manifest path, fallback entries, warnings, invalid JSON, SDK-invalid fields, missing explicit/fallback entries, explicit absolute/drive-qualified Windows/traversal escapes, canonical Junction/symlink escapes, and explicit/fallback directory entries.
- Dev creation of a Windows Junction at the manifest id.
- Idempotent same-source linking, wrong-source refusal, `--replace`, real-directory refusal, broken-link refusal, link-name containment, and case-insensitive reservation of the root-marker basename for both explicit names and manifest ids.
- Marker preflight refusal for symlinks, Junctions, directories, hard links, and unknown objects before link mutation; retained external/source targets; atomic normal refresh; post-preflight target-swap safety; and no temporary artifacts after success or failure.
- A real filesystem primitive regression proving nonrecursive unlink removes a Junction without target damage while empty directories, non-empty directories, and absence fail and are retained.
- `--no-watch` exits after linking and marker creation.
- Injected watcher tests prove debounce, `node_modules` filtering, valid marker updates, invalid no-update behavior, and signal cleanup without waiting on real filesystem timing.
- Existing Runtime tests continue to prove serialized Main/Renderer reload and lease revocation.
- Documentation and tests do not claim that an invalid Junction-source edit leaves the currently running Tweak active.
- Installer builds with the SDK dependency and the portable package materializes a resolvable SDK package.
- Documentation/package tests prove every linked authoring document is included in the release payload.

## Approved Differences from Codex++

- On 2026-08-21 the user approved this parser divergence: Codex++ accepts repeated values/booleans as arrays, ignores extra positionals, and its Sade/MRI strict configuration rejects `--no-watch` because it checks `watch` while Sade registered `no-watch`. Claude++ rejects duplicate options and extra positionals deterministically, reports missing values directly, and supports the documented `dev --no-watch`; valid command shapes stay familiar. The user-visible impact is that malformed authoring invocations fail instead of silently changing option shapes or ignoring arguments, while one-shot development works as documented. The maintenance impact is that all three adapters must continue to share one strict parser and Task 6 must pass raw command arguments to it instead of relying on Sade/MRI parsing.
- `dev --name` is restricted and containment-checked; Codex++ accepts an arbitrary name.
- Reload markers live in the Tweaks root rather than inside the linked source.
- The root-marker basename is reserved case-insensitively for explicit link names and manifest ids. Marker writes preflight for a single-link regular file and use exclusive same-directory temporary files plus atomic replacement rather than opening the marker path.
- Wrong-source replacement uses nonrecursive Junction unlink after an immediate full recheck. Hostile same-user identity swapping in the final path-based deletion instant is explicitly outside the trusted local-development guarantee; native-handle deletion is not included.
- Generated projects omit the currently unpublished npm SDK dependency and default to runnable CommonJS.
- Development links are Windows Junctions only in this release.
- Unlike Codex++, Claude++ accepts explicit and fallback entries only when the canonical target is a regular file inside the canonical Tweak source project. Absolute, drive-qualified Windows, and `..` entries and in-project Junction/symlink escapes are rejected; out-of-tree build outputs must be copied or bundled into the project.
- Claude++ keeps its stricter validator, Claude-specific permissions, in-process MCP leases, and no-configuration-write policy.
- Codex-only Owl, React, native, browser, window, view, CDP, and external MCP surfaces are not copied.
