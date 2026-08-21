# Distribution and debugging

## Release checklist

Before tagging or submitting a Tweak:

1. Build JavaScript into the project root using the correct process target.
2. Run `claudeplusplus validate-tweak .` and resolve every error; review warnings.
3. Test `start()` and `stop()` in every declared scope, including repeated reload and failure cleanup.
4. Verify requested permissions match only APIs actually used.
5. Confirm `githubRepo` uses `owner/repo`, the manifest version matches the release, and `minRuntime` is the first
   required numeric `x.y.z` Runtime.
6. Check that `manifest.main` and all assets resolve inside the project and that no source-only secrets or local paths
   ship.
7. Test on a clean profile or disposable project copy, then fully restart Claude for Renderer/startup behavior that
   cannot be proven by hot reload alone.

GitHub Releases are advisory: Claude++ checks the repository's latest non-draft release at most once per 24 hours,
compares the tag with `manifest.version`, and shows update information. It does not install arbitrary release assets.

## Reviewed Tweak Store commits

Store installation is commit-pinned. A submission resolves the current default-branch head to a full 40-character
commit SHA; review applies to exactly that source. The registry's `repo` must match `manifest.githubRepo`, and
`approvedCommitSha` must remain the reviewed SHA. Pushes after review require a new submission and review.

Store installation checks platform and `minRuntime`, validates the downloaded manifest against the approved entry,
rejects unsafe archive paths, and records hashes of the installed baseline. A later Store update refuses to overwrite
locally modified files. Keep review/release URLs and manifest metadata accurate for reviewers; do not treat a moving
branch or tag as the reviewed authority.

## Development-watch failures

The CLI's 100 ms source loop prints `invalid` and leaves the root marker unchanged when manifest or entry validation
fails. This does not preserve the currently running Tweak: Runtime independently follows the Junction, waits for
writes to stabilize, and applies its own 250 ms reload debounce. The invalid edit may already have stopped the old
instance and then failed rediscovery. Fix the source and wait for a valid marker update, or restart Claude.

Direct Junction and marker events may trigger one or two reload cycles. Test cleanup and idempotence under both. Do not
diagnose duplicate lifecycle calls solely as a CLI validation failure.

## Logs and DevTools

| Location | Use |
| --- | --- |
| `%APPDATA%\claude-plusplus\log\main.log` | Main Runtime, discovery, Main Tweak lifecycle, Store, and capability errors. |
| `%APPDATA%\claude-plusplus\log\renderer.log` | Persistent Renderer Tweak messages and Renderer load failures. |
| `%APPDATA%\claude-plusplus\log\loader.log` | Loader startup before Runtime handoff. |
| Claude DevTools Console | Renderer messages with the `[Claude++]` prefix and live DOM inspection. |

For Renderer failures, filter DevTools for `[Claude++]`, confirm the current window reconstructed, and make selectors
and DOM changes tolerate missing/replaced nodes. For Main failures, check `main.log`, catch and log long-running start
work, and ensure `stop()` closes processes, handles, timers, and registrations.

`claudeplusplus status`, `doctor`, and `debug` diagnose the Claude++ installation boundary. They do not validate a
Tweak's workflow semantics; keep project-specific health checks in the Tweak.

## Disable, uninstall, and data cleanup

Before removing a Tweak that changes startup environment or shared Claude Code settings, use its documented restore
action and verify the saved recovery state. Then disable the Tweak, reload/restart Claude, and remove only its source
directory or development Junction. The `dev` command intentionally leaves its Junction installed when it exits.

Removing source does not automatically promise deletion of:

- `%APPDATA%\claude-plusplus\storage\<tweak-id>.json`;
- `%APPDATA%\claude-plusplus\tweak-data\<tweak-id>\`;
- `%APPDATA%\claude-plusplus\startup-environment\<tweak-id>.json`;
- Renderer `localStorage` data.

Delete persistent data only after resolving the exact path and deciding recovery is no longer needed. The global
`claudeplusplus uninstall` command preserves Claude++ Tweak data by default; `--purge` removes the broader preserved
Claude++ user data and should be used only when that destructive scope is intended.

## Trust and compatibility boundary

- Main Tweaks execute as trusted local Node.js code. Permissions are API lease controls, not an OS sandbox.
- Renderer Tweaks run without Node `require`, but can modify the current Claude DOM through public browser APIs.
- Startup environment, Claude Code settings, in-process MCP, and session titles have additional recovery/private-host
  constraints documented in the [advanced guide](../tweak-authoring.md).
- Treat undocumented Claude internals, selectors, and build-specific behavior as unstable. Fail closed when a required
  compatibility check does not match, and keep a no-op/recovery path for users.
