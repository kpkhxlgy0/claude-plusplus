# Manifest reference

Every Tweak has a JSON object at `manifest.json`. The public SDK validator is the authority for its shape; the CLI and
Runtime then add entry-file and compatibility checks.

## Fields

| Field | Type | Required | Rules and use |
| --- | --- | ---: | --- |
| `id` | `string` | yes | Stable unique id using letters, numbers, `.`, `_`, and `-`. Reverse-DNS style is recommended. |
| `name` | `string` | yes | Non-empty display name used in Settings and Store views. |
| `version` | `string` | yes | A semver-shaped version such as `0.1.0`; a non-semver value currently warns. |
| `githubRepo` | `string` | yes | GitHub repository in exact `owner/repo` form. |
| `description` | `string` | no | Short human-readable description. |
| `author` | `string` or `TweakAuthor` | no | Display name, or `{ "name": "...", "url"?: "...", "email"?: "..." }`. |
| `homepage` | `string` | no | Project or documentation link. |
| `iconUrl` | `string` | no | Icon source used by the catalog/Settings UI; a project-relative asset must ship with the Tweak. |
| `tags` | `string[]` | no | Search and review metadata. |
| `minRuntime` | `string` | no | Minimum Claude++ Runtime in numeric `x.y.z` form only, for example `0.2.9`. |
| `scope` | `"renderer"`, `"main"`, or `"both"` | no | Process host. Omission warns and defaults to `both`; set it explicitly. |
| `main` | `string` | no | Project-relative entry. Without it, Runtime tries `index.js`, `index.cjs`, then `index.mjs`. |
| `permissions` | `TweakPermission[]` | no | Known capability declarations. Runtime gates the leases or operations described below. |
| `startupEnvironment` | `{ "keys": string[] }` | coupled | Required with `startup-environment`; forbidden without it. Main-capable only. |
| `claudeCodeSettings` | `{ "paths": string[] }` | coupled | Required with `claude-code-settings`; forbidden without it. Main-capable only. |

`TweakAuthor` requires a non-empty `name`; `url` and `email` are optional strings. `main` is additionally subject to
the CLI's canonical containment and regular-file checks described in [Getting started](./getting-started.md).

## Complete example

```json
{
  "id": "com.example.workflow-tools",
  "name": "Workflow Tools",
  "version": "0.1.0",
  "githubRepo": "example/workflow-tools",
  "description": "Adds a settings page backed by Main IPC.",
  "author": {
    "name": "Example Author",
    "url": "https://github.com/example"
  },
  "homepage": "https://github.com/example/workflow-tools",
  "iconUrl": "./icon.png",
  "tags": ["settings", "workflow"],
  "minRuntime": "0.2.9",
  "scope": "both",
  "main": "index.js",
  "permissions": ["ipc", "settings", "filesystem"]
}
```

## Scope and Main-capable declarations

| Scope | Main | Renderer | Guidance |
| --- | ---: | ---: | --- |
| `renderer` | no | yes | Use for Settings/DOM work and Renderer Claude Session APIs. |
| `main` | yes | no | Use for trusted Node.js work or a headless service. |
| `both` | yes | yes | Branch on `api.process`; each process gets an independent lifecycle and API lease. |

The `mcp` and `claude-session-title-write` permissions require `main` or `both`. Startup environment and Claude Code
settings declarations also require a Main-capable scope. Runtime exposes all four only to Main API leases.

Startup environment ownership is exact:

- `startup-environment` and `startupEnvironment` must appear together.
- `keys` is non-empty, unique, and uses environment names matching a leading letter/underscore followed by letters,
  digits, or underscores.
- Saved configurations must contain every declared key and no undeclared key.

Claude Code settings ownership is also exact:

- `claude-code-settings` and `claudeCodeSettings` must appear together.
- `paths` contains 1–64 unique dot-separated paths, each at most 256 characters.
- Segments use letters, digits, `_`, or `-`; `__proto__`, `prototype`, and `constructor` are rejected.
- Parent/child declarations cannot overlap, and a lease can access only an exact declared path.

See the [advanced Claude capability guide](../tweak-authoring.md) before using either declaration.

## Permissions

Claude++ recognizes exactly nine permission strings:

| Permission | Current Runtime contract |
| --- | --- |
| `ipc` | Declares namespaced Tweak IPC use. The process-specific `api.ipc` object is always delivered. |
| `filesystem` | Allows `api.fs.read`, `write`, and `exists`; the `api.fs` object exists without it but operations reject. |
| `network` | Declares network intent for review. Claude++ currently supplies no dedicated network API or Runtime guard. |
| `settings` | Exposes Renderer `api.settings` when the Settings host is available. |
| `claude-sessions` | Exposes Renderer `api.claude.sessions` for focused session file/reference/workspace resolution. |
| `startup-environment` | Exposes Main `api.startupEnvironment` and requires `startupEnvironment`. |
| `claude-code-settings` | Exposes Main `api.claudeCodeSettings` and requires `claudeCodeSettings`. |
| `mcp` | Exposes Main `api.mcp` for handler-backed, in-process Claude Desktop MCP servers. |
| `claude-session-title-write` | Exposes Main `api.claude.sessionTitles`. |

Permissions constrain Claude++ API leases. They do not sandbox Main Tweak Node.js code from the operating system.
Declare only capabilities the Tweak actually uses.

## Compatibility, releases, and Store review

Runtime skips a Tweak when its current version is lower than numeric `minRuntime`. Set `minRuntime` to the first
Claude++ version that provides every API or private compatibility boundary the Tweak needs.

`githubRepo` drives advisory GitHub release checks. During an installed catalog request, every row whose entry exists
is automatically checked, including disabled and runtime-incompatible rows; neither enabled state nor `minRuntime`
compatibility filters the request. A missing-entry diagnostic row starts no request. It can display cached data only
when the cached repository and installed version both match its current manifest.

The check identity is the absolute config path plus manifest id, `githubRepo`, and installed manifest version. A
matching persistent result younger than 24 hours is reused, and overlapping calls for that exact identity share one
process-local in-flight promise. Repository, installed-version, or config-path changes create a different identity.
Automatic checks download JSON metadata only. The result is a GitHub release-review link, not an installer, and
Claude++ does not install arbitrary release assets.

The reviewed Tweak Store keeps review data outside `manifest.json`. A Store registry entry repeats the validated
manifest, matches its `githubRepo`, and pins `approvedCommitSha` to the exact reviewed 40-character commit. Reviewers
may also record supported platforms, review/release links, reviewer identity, and approval time. If source changes,
submit the new full commit for review rather than moving the approved pin. Store update also refuses to overwrite a
locally modified installed baseline.
