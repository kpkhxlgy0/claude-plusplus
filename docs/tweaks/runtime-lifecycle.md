# Runtime and lifecycle

Claude++ discovers Tweak directories from the Windows roaming user root, starts Main-capable entries in Electron Main,
and reconstructs Renderer-capable entries inside each Claude preload. A `scope: "both"` Tweak is evaluated separately
and receives a distinct API lease in each process.

## Discovery and start

For each directory below `%APPDATA%\claude-plusplus\tweaks`, Runtime:

1. reads and validates `manifest.json`;
2. resolves explicit `main` or the `index.js`, `index.cjs`, `index.mjs` fallback order;
3. checks `minRuntime`, enabled state, Safe Mode, and process scope;
4. evaluates the CommonJS-shaped export and calls `start(api)`.

Invalid manifests, missing entries, incompatible versions, disabled Tweaks, and wrong-process scopes are skipped. A
Tweak evaluation/start error is logged and isolated so later Tweaks can still start.

Renderer source is evaluated in the preload with `module`, `exports`, `console`, and the process API. The `require`
argument is explicitly `undefined`; bundle all Renderer dependencies. Settings registrations are tracked as part of
the Renderer lease.

## Stop and lease revocation

Export an idempotent cleanup hook:

```js
module.exports = {
  async start(api) {
    // Acquire resources for this process instance.
  },
  async stop() {
    // Release resources acquired by start().
  },
};
```

Main stops started Tweaks in reverse start order. For each Tweak, Runtime awaits `stop()` and then disposes its API
lease even if stop reports an error. Lease disposal revokes registered IPC handlers/listeners, storage flushing,
startup-environment and Claude Code settings references, MCP registrations, and session-title references as
applicable. Retained gated API references reject after disposal.

Renderer reconstruction also stops the old lifecycle before clearing Settings registrations and loading fresh
catalog/source state.

## Runtime hot reload order

The Main reload queue is serialized. Each reload performs:

1. stop all Main Tweaks in reverse order and dispose their leases;
2. clear Node module-cache entries rooted under the Tweaks directory;
3. rediscover valid Main Tweaks;
4. start the new Main set;
5. broadcast the reload reason;
6. let every Renderer stop its current Tweaks, clear Settings, reread the catalog/source, and start fresh instances.

Make DOM and Main mutations repeatable. Claude itself may also rerender page DOM independently of a Tweak reload.

## Development watchers

`claudeplusplus dev` and Runtime are independent watchers:

- The CLI recursively watches the selected source, ignores `node_modules` and reload-marker names, and debounces by
  100 ms. At settlement it reruns strict manifest/entry validation. A valid project atomically refreshes
  `%APPDATA%\claude-plusplus\tweaks\.claudepp-dev-reload`; an invalid project prints `invalid` and does not update the
  marker.
- Runtime watches the live Tweaks root with Chokidar's default Junction following. It waits for writes to stabilize for
  150 ms (50 ms polling), then applies its own 250 ms reload debounce before running the lifecycle order above.

The root marker is a deterministic supplemental success signal, not a validation gate for Runtime. A source edit can
reach Runtime directly through the development Junction before or independently of CLI validation. Therefore an
invalid edit may stop the old Tweak and then fail rediscovery even though the CLI refuses to update the marker. Direct
and marker events often coalesce, but they are not guaranteed to; one edit can produce two reload cycles.

`--no-watch` performs initial validation, Junction setup, and marker refresh, then exits. Normal watcher exit does not
delete the Junction.

## Safe Mode and enable state

`%APPDATA%\claude-plusplus\config.json` stores global Safe Mode and per-Tweak enabled state. Missing per-Tweak state
means enabled. Safe Mode disables Tweak execution and startup-environment application. Changing it writes the
`.claudepp-safe-mode-reload` marker, so a live Runtime reloads and filters active Main Tweaks immediately, then
broadcasts reload to any already-registered Renderer preload. The CLI still reports `restartRequired`: fully restart
Claude to apply the startup-environment decision and establish or remove the launch-time Renderer preload/CSP
boundary. A malformed config is not silently overwritten by a mutation command.

## Cleanup checklist

Release every owned resource in `stop()` or through a tracked handle:

- Settings handles returned by `api.settings.register` and `registerPage`;
- DOM nodes and `<style>` elements inserted outside managed Settings roots;
- window/document/DOM event listeners;
- `MutationObserver`, `ResizeObserver`, and `IntersectionObserver` instances;
- timeouts, intervals, streams, file handles, and child processes;
- unsubscribe functions from `api.ipc.on`;
- explicit MCP `unregister()` handles and any other disposable registration;
- temporary state that must not be retained by a fresh process instance.

Runtime lease disposal is a backstop, not a replacement for clear Tweak-owned cleanup.

## Storage and logs

| Purpose | Location |
| --- | --- |
| Installed/live Tweak sources and development Junctions | `%APPDATA%\claude-plusplus\tweaks\` |
| Main `api.storage` | `%APPDATA%\claude-plusplus\storage\<tweak-id>.json` |
| Renderer `api.storage` | `localStorage["claudepp:storage:<tweak-id>"]` |
| `api.fs` data | `%APPDATA%\claude-plusplus\tweak-data\<tweak-id>\` |
| Startup-environment snapshot | `%APPDATA%\claude-plusplus\startup-environment\<tweak-id>.json` |
| Runtime config and enable flags | `%APPDATA%\claude-plusplus\config.json` |
| Main log | `%APPDATA%\claude-plusplus\log\main.log` |
| Renderer Tweak log | `%APPDATA%\claude-plusplus\log\renderer.log` and DevTools with `[Claude++]` |
| Loader log | `%APPDATA%\claude-plusplus\log\loader.log` |

`api.fs` is contained to its Tweak data directory and Renderer operations are proxied through Main. Removing a Tweak
source does not itself promise deletion of its storage, data, or startup snapshot; plan explicit recovery before
removing persistent state.
