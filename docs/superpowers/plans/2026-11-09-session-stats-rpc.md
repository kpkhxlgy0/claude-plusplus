# Authenticated session statistics RPC

**Goal:** Let the Session Stats Tweak obtain sanitized numeric snapshots through the current authenticated Desktop
Remote Control bridge, including the active child agent, without a general remote filesystem endpoint.

**Observable success:** A valid request returns only the exact bridge/organization/agent snapshot; cancelled, revoked,
stale, malformed, oversized and foreign results cannot reach the requesting page. Unknown native requests retain their
original behavior. Unsupported native builds keep Claude running without injection.

**Approved Codex++ divergence:** The installed Codex++ Session Stats Tweak uses the existing authenticated host transport
and native `fs/getMetadata` / `fs/readFile` methods to read a fixed hidden snapshot. Claude has `read_file`, but lacks
the equivalent remote configuration-root resolver and general native filesystem API; `get_settings` is explicitly
unsupported. The user explicitly approved a core-owned, authenticated session-scoped statistics RPC instead. The
Tweak retains aggregation and hidden `<CLAUDE_CONFIG_DIR>/.session-stats` publication; Runtime owns native compatibility,
permission gates, provider lifetime and numeric-only validation. This adds a version-locked native compile adapter and
requires a full Desktop restart on upgrade; it does not create a generic read-file RPC or change Codex++ behavior.

**Native evidence:** Desktop `app.getVersion()` is `4.23118.0`. The verified chunk is
`.vite/build/index.chunk-DhrjLA58.js`, SHA-256
`c00b0a0617993d7dca342b94cac1fef4ac667f80f8953700b1d3dc87dd4788d4`.
Its `Ehe` ingress predicate accepts any control request with a request ID and non-null request; `Dhe` forwards it without
a subtype whitelist. `zhe` enforces shutdown/outbound-only gates, then invokes its optional `answerSharedControlRequest`
hook before the native subtype switch. The unique `MTe` callsite omits that optional hook. Inject only that property and
its request-specific write guard, retaining native Promise response serialization and cancellation-map handling.
The same hash gate requires exact single connection/close callback markers. The bridge lifetime records closed state
and a connection generation; old requests cannot reply after close or after reconnecting the same transport object.

## Implementation

- [x] Add Main-only SDK permission and synchronous `sessionStats.registerProvider(handler)` lease API.
- [x] Keep the adapter independent of the older four-module MCP compatibility whitelist.
- [x] Install the compile hook synchronously before the Loader requires Claude's native entry.
- [x] Require exact Desktop version, native ASAR path suffix, full chunk SHA-256 and exactly one known callsite.
- [x] Bind session identity from native closure state, not caller input; validate organization and optional agent.
- [x] Validate the existing schema 1/2 numeric snapshot with 16 KiB, 30-second age and 5-second future-skew limits.
- [x] Revoke registrations synchronously, abort pending work, and suppress responses after cancellation or transport drift.
- [x] Bound providers to 5 seconds, 32 total requests and 8 requests per connection; return generic errors only.
- [x] Add focused tests first for contracts, lifecycle, identity, validation, cancellation and compatibility drift.
- [x] Bump the coordinated source/package version to 0.3.9 without committing, releasing or publishing.
- [x] Complete final build, automated verification and full native chunk syntax check; report fresh results.

No installation, app restart, UI automation, remote transport traffic, publishing or credential access is part of this
core implementation task. The parent task owns Tweak integration and any separately authorized installation.

## Verification record

- `npm run build`: all four workspaces passed at version 0.3.9.
- Focused API, Main lifecycle, SDK and repository-shape run: 77 passed before the final close-generation regression;
  the final adapter/service run passed all 13 tests including that regression.
- The complete verified 1,079,688-byte native chunk was transformed in memory and parsed with `vm.Script`; syntax
  passed, and the native module was never executed. No upstream chunk copy or scratch artifact was written.
- `npm test`: 783 tests ran, 781 passed, and two update-service fixtures failed because their formerly future release
  0.3.9 became the current version. After adjusting those fixtures to future 0.3.10 and equal-core 0.3.9-beta.1, the
  complete update-service test file passed all 19 tests. The full suite was not repeated after that fixture-only fix.
- `git diff --check` passed. Native Desktop/Remote Control end-to-end behavior still requires the parent task's
  separately authorized install/restart and live verification; fixture tests do not claim that result.

## Release follow-up

The user completed local installation and restart, then explicitly requested publication of core 0.3.9 and Session
Stats 0.8.0 before updating the other device. Installed Runtime hashes, provider registration and fresh parent/child
snapshots matched the local build. Cross-machine acceptance remains pending the other endpoint's upgrade.

Tracing the current native host also identified the alternate CCR/SSE branch selected when its SDK feature gate is
off. That branch does not load the SDK chunk and ignores unknown control requests. It now joins the same stats service
at its authenticated inbound transport callback in `.vite/build/index.chunk-CUXoxsyW.js`, SHA-256
`8a49065ed8437a1e4d91c972524044ad58c73eebcac521729a9bc9d9472fab32`.

The CCR adapter derives bridge and organization identity from native host state, owns a per-connection cancellation map,
and returns replies through the native write queue. Its queued write rechecks connection identity, disposal and provider
lifetime. It consumes only stats requests and cancellations for its own outstanding requests. Native session traffic
and other control requests keep their original dispatch. Both modules have independent exact hash and marker guards;
the early compile hook remains installed until both lazy modules have been observed or Runtime is disposed.

Final release verification: all 792 tests passed with zero failures or skips after both native transport adapters were
included. All four workspaces built successfully. The Windows archive passed checksum and isolated portable-CLI
version, status, Doctor and Tweak authoring checks. Its SHA-256 is
`202406b062da54d5a11c43e7115b03dc4b6d44b4d000af15970938a4de69a07b`.
Independent review reported no remaining material findings. The review and tests do not claim cross-machine acceptance.
