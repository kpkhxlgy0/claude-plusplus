# Bounded Renderer Tweak CSP Compatibility Design

## Goal

Restore Claude++ Renderer Tweak execution in current Claude Desktop builds while preserving the existing Tweak lifecycle and junction-backed hot reload behavior.

The observable success conditions are:

- Renderer Tweaks no longer fail with the Content Security Policy `unsafe-eval` error.
- A source change under the Unity Links Claude Tweak submodule is automatically reloaded without restarting Claude.
- Clicking an eligible Unity project link reaches the matching open Unity Editor.
- Web links, modified clicks, directories, missing paths outside the handled failure behavior, and files outside supported Unity roots retain Claude's original behavior.

## Source ownership

The Unity Links Claude Tweak is maintained as a submodule of the Unity Links aggregate repository:

- Aggregate repository: `D:\workspace\sgproj\FilePackages\unity-links`
- Claude Tweak submodule: `D:\workspace\sgproj\FilePackages\unity-links\claude-tweak`
- Installed Claude++ Tweak junction: `%APPDATA%\claude-plusplus\tweaks\com.kpk.unity-asset-links`

The installed junction must continue to target the submodule directory. It is a deployment link, not an independent source checkout. This CSP compatibility change belongs in Claude++, not in the Unity Links Tweak.

## Reference architecture and approved divergence

Installed Codex++ 1.0.0 loads Renderer Tweaks by reading their source through IPC and evaluating it with `new Function` inside its sandboxed preload context. Claude++ follows the same architecture and adds API leasing and explicit reconstruction lifecycle handling.

Current Claude Desktop applies a Content Security Policy that rejects `new Function` because `script-src` does not include `'unsafe-eval'`. The installed Codex host does not exhibit that restriction, so Codex++ does not need host CSP compatibility handling.

The approved Claude++ divergence is:

- Retain Codex++'s source-string evaluator and the current Claude++ lifecycle.
- Add narrowly scoped Claude-host compatibility that inserts `'unsafe-eval'` into `script-src` only for managed Claude `app:` top-level Renderer documents.
- Do not add `'unsafe-inline'`, remove existing sources, weaken other directives, or modify web/login/DevTools responses.

This divergence restores the existing Tweak ABI without requiring Unity Links or other Tweaks to migrate.

## Runtime design

### CSP transformation

Add a small CSP transformation unit in the Claude++ runtime with these properties:

- Header-name matching is case-insensitive.
- Existing directive order and values are preserved except for inserting one missing `'unsafe-eval'` source into `script-src`.
- Repeated application is idempotent.
- Multiple policy values are handled independently.
- A policy without `script-src` is left unchanged rather than inventing a new execution policy.
- Malformed or unrecognized policies are left unchanged and logged without preventing Claude from loading.

### Session registration

Install one response-header compositor alongside Renderer preload registration. Electron keeps only the last
`WebRequest` listener, while current Claude registers its own unfiltered `onHeadersReceived` listener after Claude++
starts. Claude++ therefore wraps that registration point and keeps one effective listener which runs Claude's latest
listener first, then applies the bounded CSP transformation to the returned headers. Each Electron `Session` is
registered at most once.

If a future Claude build uses the filtered registration overload, Claude++ preserves the host registration and fails
closed by disabling CSP compatibility for that Session with a diagnostic rather than approximating Electron URL
filter semantics. Safe Mode still installs the management preload, but does not install the CSP compositor because it
does not evaluate Renderer Tweaks.

The hook changes a response only when all of these conditions hold:

- The request is a top-level document.
- Its URL uses the `app:` protocol used by managed Claude Renderer windows.
- A `Content-Security-Policy` response header exists.
- Its `script-src` does not already contain `'unsafe-eval'`.

All other responses pass through unchanged. In particular, the hook does not alter `http:`, `https:`, authentication, DevTools, iframe, script, image, API, or extension resources.

The implementation must preserve `sandbox=true` and `contextIsolation=true` and must not add Node access to Renderer Tweaks.

### Meta-policy boundary

The initial implementation handles response-header CSP only. It does not rewrite Claude HTML or a `<meta http-equiv="Content-Security-Policy">` element.

Runtime diagnostics and an integration check must prove that the effective failing policy is changed. If a future Claude build moves the relevant policy exclusively into HTML metadata, that is a new compatibility case requiring a separate reviewed design rather than a silent broadening of this patch.

## Hot reload behavior

The existing hot reload path remains unchanged:

1. `TweakManager.watch()` observes the configured Tweak directory, including source changes reached through the installed junction.
2. Main stops current Main Tweaks, clears their module cache, reloads them, and broadcasts `claudepp:tweaks-changed`.
3. Renderer receives the event and starts one serialized reconstruction.
4. The current Renderer lifecycle calls `stopAll()`, disposes API leases and registered settings, and clears settings state.
5. Renderer reloads the catalog and current source from the junction target.
6. The CSP-compatible evaluator creates a fresh Tweak scope and starts the new instance.

Updating Claude++ runtime code itself still requires rebuilding, installing, and restarting Claude once. After that installation, modifying `D:\workspace\sgproj\FilePackages\unity-links\claude-tweak\index.js` must continue to reload the Tweak automatically without a Claude restart.

## Error handling and diagnostics

- Log once when the CSP compatibility hook is installed for a Session.
- Preserve current Claude's response-header changes and ensure its callback can complete the request only once.
- If Claude's listener throws, preserve the original response headers and leave CSP unchanged.
- Log and fail closed if Claude switches to an unsupported filtered response-header listener.
- Log whether a qualifying policy was changed, while avoiding full page content and unrelated response data.
- Leave an unrecognized policy unchanged and emit a concise warning.
- Keep existing per-Tweak evaluation isolation: one failed Renderer Tweak must not prevent later Tweaks from starting.
- Keep Unity Links' existing fallback: if the matching Unity named pipe is unavailable, reveal the asset in Explorer and show the short notice rather than launching Unity.

## Tests

### Unit tests

Add focused tests for:

- adding `'unsafe-eval'` to an existing `script-src`;
- preserving every other directive and source;
- idempotent repeated transformation;
- case-insensitive CSP header detection;
- multiple header values;
- no CSP header;
- no `script-src` directive;
- malformed policy input;
- rejecting non-`app:` requests;
- rejecting non-main-frame resource types;
- registering each Electron Session only once.
- composing the current Claude response-header listener with the CSP transformation;
- preventing duplicate host callbacks from completing a request twice;
- leaving the CSP compositor unregistered in Safe Mode.

Existing Renderer Tweak host tests remain the regression suite for source evaluation, API leasing, failure isolation, cleanup, and reconstruction.

### Integration verification

After building and installing Claude++:

1. Restart Claude once to load the updated runtime.
2. Verify `renderer.log` contains no `unsafe-eval is not an allowed source` failure for `com.kpk.unity-asset-links`.
3. Verify the Unity Links Renderer Tweak starts.
4. Modify the submodule's `index.js` in a behavior-neutral way during development and verify that the watcher triggers Renderer reconstruction; restore the file afterward.
5. With `sgproj` open in Unity, click an eligible `Assets` link and verify Unity opens or selects the asset.
6. Verify a supported C# link carries line and column information.
7. Verify ordinary web links, modifier-key clicks, relative paths, directories, and paths outside `Assets`, `ProjectSettings`, and `Packages` retain Claude's original handling.

## Scope exclusions

This change does not:

- alter the Unity Links Tweak or Unity package ABI;
- change the Unity Links aggregate repository's submodule pins;
- replace the Renderer Tweak evaluator;
- add a URL scheme, native host, localhost service, registry entry, or Unity process launcher;
- enable `'unsafe-inline'`;
- weaken CSP for web content or authentication surfaces;
- redesign Claude++ Tweak installation or hot reload.
