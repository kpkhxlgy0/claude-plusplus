# Getting started

A Tweak is a JavaScript project discovered below `%APPDATA%\claude-plusplus\tweaks`. The generated project is
dependency-free CommonJS and contains exactly four files:

```text
my-tweak/
  manifest.json  # identity, process scope, entry, permissions
  index.js       # CommonJS lifecycle module
  package.json   # private package with validate/dev scripts
  README.md      # project-specific development notes
```

## Create a project

```text
claudeplusplus create-tweak <target>
  [--id <id>]
  [--name <display-name>]
  [--repo <owner/repo>]
  [--scope renderer|main|both]
  [--force]
```

For example:

```powershell
claudeplusplus create-tweak .\my-tweak `
  --id com.example.my-tweak `
  --name "My Tweak" `
  --repo example/my-tweak `
  --scope both
```

The target must be new. An existing directory must be empty and requires `--force`; the command never overwrites an
existing file or non-empty directory. The default scope is `both`. The scaffold requests only the permissions its
template uses and has no SDK dependency.

## Validate

```text
claudeplusplus validate-tweak [target]
```

`target` defaults to `.` and may be either the project directory or its `manifest.json`. Validation parses the
manifest once, applies `@claude-plusplus/sdk.validateTweakManifest`, then resolves the entry without executing it.
Warnings are printed but do not fail validation; any error produces a non-zero exit.

Entry resolution is:

1. explicit `manifest.main`, when present;
2. `index.js`;
3. `index.cjs`;
4. `index.mjs`.

An accepted entry must be a regular file whose canonical target remains inside the canonical project directory.
Explicit absolute paths, drive-qualified paths, `..` segments, directories, and Junction/symlink escapes are rejected.
Bundle or copy out-of-tree build output into the project instead of pointing `main` outside it.

The scaffolded scripts run the same commands:

```powershell
npm run validate
npm run dev
npm run dev -- --no-watch
```

## Develop through a Junction

```text
claudeplusplus dev [target]
  [--name <link-name>]
  [--replace]
  [--no-watch]
```

The source may be anywhere you selected. On Windows, `dev` validates it before creating an immediate-child directory
Junction at `%APPDATA%\claude-plusplus\tweaks\<link-name>`; the default link name is `manifest.id`. A Junction that
already targets this source is reused. `--replace` may replace only a different, fully rechecked Junction—never a real
file, real directory, or broken/malformed link. `--no-watch` links once, refreshes the reload marker, and exits.

With watching enabled, valid settled source changes refresh a supplemental root marker. See
[Runtime and lifecycle](./runtime-lifecycle.md#development-watchers) for the separate CLI and Runtime watcher behavior,
including what happens after an invalid edit. Exiting the CLI leaves the development Junction installed.

## Choose a process scope

| Scope | Loaded in | Typical work |
| --- | --- | --- |
| `renderer` | Renderer preload | Settings UI, DOM work, and focused Claude Session reference resolution. |
| `main` | Electron Main | Trusted Node.js work and Main-only Claude capabilities. |
| `both` | Both, as independent instances | Renderer UI backed by namespaced Main IPC handlers. |

Every entry exports `start(api)` and should export `stop()`:

```js
module.exports = {
  start(api) {
    if (api.process === "main") {
      api.ipc.handle("ping", () => "pong");
      return;
    }
    // Renderer-only DOM work belongs inside this branch.
  },
  stop() {
    // Release handles, listeners, timers, observers, and external resources.
  },
};
```

`scope: "both"` loads the same entry separately in Main and Renderer, so do not share process state or assume one
instance started first. Renderer receives no Node `require`.

Renderer hot reload reconstructs Tweak state in each current Claude window. If a Renderer change cannot apply cleanly
to an existing Claude Session, fully restart Claude and reproduce against a fresh window before treating it as a
Runtime failure.
