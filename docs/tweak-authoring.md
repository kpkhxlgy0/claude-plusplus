# Tweak authoring

Claude++ Tweaks are CommonJS modules with a `start(api)` lifecycle and an optional `stop()` lifecycle. Their `manifest.json` declares both the processes in which they run and the capabilities exposed by each process-specific API lease.

This document describes the focused Claude Code settings capability added in Claude++ 0.2.5.

## Claude Code settings capability

Use this capability only when a Main-capable Tweak must manage one or more known Claude Code user-setting leaves. It does not provide general file access.

The permission and declaration are inseparable:

```json
{
  "scope": "both",
  "permissions": [
    "ipc",
    "settings",
    "claude-code-settings"
  ],
  "claudeCodeSettings": {
    "paths": [
      "skillOverrides.claude-api"
    ]
  }
}
```

Rules:

- `scope` must be `"main"` or `"both"`; Renderer-only Tweaks cannot request this capability.
- `claude-code-settings` without `claudeCodeSettings`, or a declaration without the permission, is invalid.
- `paths` must contain 1 to 64 unique dotted paths.
- Each path is limited to 256 characters and contains only identifier-like segments using letters, digits, `_`, or `-`.
- `__proto__`, `prototype`, and `constructor` segments are rejected.
- Parent/child overlap is rejected. Declaring `skillOverrides` together with `skillOverrides.claude-api` is invalid.

## Main-only API

A valid Main lease exposes:

```ts
interface ClaudeCodeSettingsApi {
  read(path: string): ClaudeCodeSettingsRead;
  write(
    path: string,
    value: ClaudeCodeSettingsJsonValue,
    expectedRevision: string,
  ): ClaudeCodeSettingsRead;
  remove(path: string, expectedRevision: string): ClaudeCodeSettingsRead;
}

interface ClaudeCodeSettingsRead {
  exists: boolean;
  value?: ClaudeCodeSettingsJsonValue;
  revision: string;
}
```

Renderer leases never expose `api.claudeCodeSettings`. A `scope: "both"` Tweak should register namespaced handlers in Main through `api.ipc.handle(...)`, then call those handlers from its Renderer Settings page through `api.ipc.invoke(...)`.

Every operation must use a path exactly equal to one manifest entry. Declaring `skillOverrides.claude-api` does not permit access to:

- its parent: `skillOverrides`;
- its child: `skillOverrides.claude-api.extra`;
- its sibling: `skillOverrides.doctor`.

## Revision-guarded mutation

Read immediately before mutation and pass the returned whole-file revision:

```js
const path = "skillOverrides.claude-api";
const current = api.claudeCodeSettings.read(path);
const updated = api.claudeCodeSettings.write(path, "off", current.revision);
```

To restore an originally missing leaf:

```js
const current = api.claudeCodeSettings.read(path);
const updated = api.claudeCodeSettings.remove(path, current.revision);
```

A missing settings file uses the revision `missing:v1`. Existing files use `sha256:<digest>`, calculated from the complete original file bytes. If any writer changes the file after the read, `write` or `remove` rejects the stale revision instead of replacing the file. Reload and ask the user to retry; do not silently overwrite the external change.

Mutations parse the full JSON object, clone it, alter only the declared leaf, write a unique sibling staging file, check the revision again, and atomically rename the staging file over the target. Unrelated settings are preserved semantically, though formatting is normalized when a change is written.

Node's standard filesystem APIs do not provide cross-process compare-and-swap. An arbitrary external writer can still race the small interval between the final revision check and atomic rename. Tweak UI and documentation must not describe the operation as absolutely race-free.

## Data and file validation

The API accepts JSON-compatible values only. It rejects non-finite numbers, circular references, non-plain object prototypes, and unsafe object keys. Reads and writes also reject:

- malformed JSON;
- array or primitive document roots;
- a non-object intermediate segment;
- a symbolic-link `settings.json`.

A missing file is treated as an empty object. A no-op remove does not create the file. Removing a leaf conservatively retains empty parent objects.

The default file is `~/.claude/settings.json`. If `CLAUDE_CONFIG_DIR` is set, the API targets `settings.json` under that redirected Claude user directory.

## Shared product scope

Claude Desktop and terminal Claude Code share user settings by default. A Tweak that writes this file must describe that shared scope in its Settings page and README. This API does not create a Desktop-only settings layer.

Higher-precedence command-line, local-project, project, or managed settings may change the effective result. Do not use `CLAUDE_CONFIG_DIR` as a single-setting isolation mechanism: it redirects the entire Claude user directory, including authentication, plugins, user skills, agents, memory, and settings.

## Recovery-state pattern

For a reversible override:

1. Read the leaf and save whether it exists plus its value in `api.storage`.
2. Persist that recovery record before writing the override.
3. Mark the record active only after the settings write succeeds.
4. On restore, read again and require the current value to still match the Tweak's override, or to already equal the saved original.
5. Refuse to overwrite an unexpected external value; offer a separate action that clears only the management record.
6. Restore before the user globally disables or uninstalls the Tweak.

Installing or loading a Tweak should not apply a user-setting override unless its documented purpose explicitly requires automatic mutation. Prefer an explicit Settings-page save action.

## Lease lifetime and trust boundary

All retained capability references reject calls after their Main lease is disposed. Do not cache them across reloads.

Main Tweaks are trusted local Node.js code. Manifest permissions constrain the APIs supported and supplied by Claude++; they are not an operating-system sandbox against malicious Main Tweak code.
