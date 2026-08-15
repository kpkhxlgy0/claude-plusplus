# GPT Context Window Tweak Design

**Date:** 2026-08-15

## Summary

Add a Claude++ Tweak named **GPT Context Window** (`com.kpk.gpt-context-window`) that configures the
Claude Code client-side context and automatic-compaction thresholds used by Claude Desktop sessions routed to GPT
models through CC-Switch.

The Tweak stores three integer values and an internal enable switch. Changes are intentionally restart-gated. On the
next full Claude Desktop launch, Claude++ applies the saved values to the current Claude process before Claude's
original main entry loads. It never writes Windows user/system environment variables, the registry, or
`~/.claude/settings.json`.

The implementation spans two repositories:

- Claude++ core capability: `D:\Unity\ClaudePlusPlus`
- Standalone Tweak repository: `D:\workspace\sgproj\FilePackages\gpt-context-window`
- Installed Tweak Junction: `%APPDATA%\claude-plusplus\tweaks\com.kpk.gpt-context-window`

## Goals

- Configure these three process-scoped variables:
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
- Apply a saved configuration before Claude's original main process entry runs.
- Make a saved configuration effective for every Code/Cowork session created or resumed after the restart.
- Preserve and restore the incoming process environment when the feature is disabled.
- Keep the Tweak settings page accessible while its internal feature switch is off.
- Match existing Claude++/Codex++ Tweak settings-page and lifecycle conventions wherever the host architecture allows.

## Non-goals

- No live modification of a session that is already running.
- No per-session or per-model override. The variables are process-scoped and therefore affect all Code/Cowork sessions
  in that Claude launch, including sessions used after switching away from a GPT provider.
- No Windows user/system environment mutation and no registry write.
- No modification of `~/.claude/settings.json`.
- No server-side compaction option in the first version.
- No CC-Switch source modification or additional local proxy service.

## Codex++ Comparison and Approved Divergence

Codex++ remains the primary reference for Tweak manifest validation, permissions, storage ownership, settings-page
registration, Main/Renderer separation, lifecycle cleanup, and restart UX.

Codex++ does not currently provide an early-start Tweak API. Ordinary Claude++ Main Tweaks also start only after
`app.whenReady()`, while the Claude++ loader imports its runtime before importing Claude's original main entry. A normal
Main Tweak can therefore set `process.env` only after Claude has registered and may already have executed host-ready
work. That timing cannot guarantee that every session-launch path observes the override.

The user explicitly approved one divergence from Codex++: Claude++ will add a small, permission-gated startup
environment bridge that runs synchronously before Claude's original main entry. GPT-specific policy remains entirely
inside the standalone Tweak; Claude++ core only supplies the generic early-start mechanism.

No other Codex++ divergence is approved by this design.

## Why Server-side Compaction Is Excluded

Claude Desktop uses Anthropic Messages semantics. Anthropic server compaction is expressed through
`context_management.edits` with a `compact_20260112` strategy. OpenAI remote compaction instead uses the Responses API
`/v1/responses/compact` endpoint.

The installed CC-Switch Router is version `3.19.2`. It supports passthrough of `/responses/compact` for clients such as
Codex that call that endpoint directly, but its current Anthropic-to-Responses conversion does not translate
`context_management` and does not orchestrate an OpenAI compact request on Claude Desktop's behalf. It also does not
round-trip OpenAI compaction items as Anthropic compaction blocks.

Consequently, a Claude++ Tweak alone cannot provide GPT server-side compaction on the current route. Supporting it
would require a separate CC-Switch Router design and implementation and is intentionally outside this feature.

References:

- Anthropic server compaction: <https://platform.claude.com/docs/zh-CN/build-with-claude/compaction>
- OpenAI Responses compact endpoint: <https://platform.openai.com/docs/api-reference/responses/compact>
- CC-Switch Anthropic-to-Responses conversion:
  <https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/transform_responses.rs#L277-L420>
- CC-Switch `/responses/compact` route history: <https://github.com/farion1231/cc-switch/issues/1144>

## Architecture

### 1. Permission-gated startup environment bridge

Claude++ adds a generic startup environment capability with an explicit manifest permission named
`startup-environment`. A Tweak using the capability must also declare the exact environment keys it owns in its
manifest. The GPT Context Window manifest owns only the three keys listed in this design.

The bridge has two phases:

1. **Synchronous startup phase:** before Claude's original main entry loads, discover enabled Tweak manifests, validate
   their declared startup-environment permissions and keys, read their persisted startup snapshots, capture the incoming
   values, and apply valid enabled overlays.
2. **Normal Main Tweak phase:** after `app.whenReady()`, expose a lease-scoped Main API that can read status, atomically
   replace the Tweak's next-launch snapshot, and request a baseline-safe application restart.

The bridge does not execute third-party Tweak code during the synchronous startup phase. It reads declarative manifests
and data only. This avoids moving arbitrary Tweak execution ahead of Claude's original entry.

### 2. Single authoritative snapshot

The startup bridge's per-Tweak snapshot is the only authoritative configuration. The Tweak must not duplicate these
values into Renderer local storage or a second Main storage document.

The Renderer settings page reaches the Main API through a Tweak-owned IPC channel. The Main half validates ownership
and delegates reads, writes, status queries, and restart requests to the bridge.

### 3. Tweak process split

The Tweak uses `scope: "both"`:

- **Renderer:** registers the settings page, renders controls and inline validation, and invokes Main handlers.
- **Main:** registers namespaced IPC handlers, performs semantic validation, uses the startup-environment API, and
  disposes every handler on stop.

The Renderer must unregister the page and release listeners when stopped. Retained API references must fail after their
lease is disposed, following the resource-revocation pattern already used by Claude++/Codex++ Tweak hosts.

## Manifest Contract

The SDK manifest schema gains the minimum declarative surface required by the bridge:

```json
{
  "id": "com.kpk.gpt-context-window",
  "name": "GPT Context Window",
  "scope": "both",
  "permissions": ["ipc", "settings", "startup-environment"],
  "startupEnvironment": {
    "keys": [
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"
    ]
  }
}
```

Manifest validation must reject duplicate keys, invalid environment-variable names, an environment declaration without
the permission, or the permission without a valid declaration. The startup bridge must ignore a missing, invalid,
globally disabled, or Safe-Mode Tweak.

Two enabled Tweaks may not own the same key. A conflict fails closed for every snapshot involved in the conflict and
produces a compatibility diagnostic; none of those snapshots is partially applied or selected by load order.

## Persisted Data

The bridge stores one versioned document per Tweak at
`%APPDATA%\claude-plusplus\startup-environment\<validated-tweak-id>.json`.

```json
{
  "version": 1,
  "enabled": false,
  "variables": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "272000",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "250000",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "85"
  }
}
```

Writes use a temporary sibling followed by atomic replacement. Only declared keys are accepted. Keys and values must
be strings; unknown top-level fields are ignored for forward compatibility, while an unknown `version` fails closed.

The early bridge validates document structure, version, manifest ownership, and declared keys. GPT-specific numeric
and cross-field validation belongs to the Tweak Main half and runs before the bridge accepts a replacement document.
The bridge does not duplicate Tweak-specific rules or execute Tweak code during early startup. Direct manual editing of
the bridge-owned snapshot is unsupported.

The internal `enabled` field is independent of the Claude++ global Tweak switch. Turning the internal switch off keeps
the settings page available and preserves the three saved values, but the next launch applies no overlay.

On first installation, the internal switch defaults to off while the three inputs are prefilled with their defaults.
No snapshot is created merely by opening the page. The user must explicitly enable the feature, save, and restart
before Claude++ applies an overlay.

## Defaults and Validation

Defaults:

| Setting | Environment key | Default |
| --- | --- | ---: |
| Maximum context tokens | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `272000` |
| Auto-compact window tokens | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `250000` |
| Auto-compact threshold percentage | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `85` |

All values must be base-10 integers:

- maximum context tokens must be greater than `100000`;
- auto-compact window tokens must be at least `100000` and strictly less than maximum context tokens;
- auto-compact threshold percentage must be from `1` through `100`, inclusive.

Renderer validation supplies immediate field-level feedback. Main validation repeats every rule and is authoritative.
If any field is invalid, no field is saved and no startup variable is applied from that document.

## Startup, Save, and Restore Flow

### Startup

1. Claude++ runtime loads before Claude's original main entry.
2. The bridge reads Claude++ Safe Mode and global Tweak enablement.
3. For each eligible manifest, it validates permission, key ownership, and snapshot structure and version.
4. It captures each owned key's incoming state, distinguishing an undefined key from an empty or non-empty value.
5. It applies the complete valid overlay synchronously.
6. Claude's original main entry loads and all subsequently launched session processes inherit the values.
7. The bridge retains an in-memory applied snapshot and incoming baseline for settings status and safe relaunch.

### Save

1. Renderer submits the internal switch and all three values through Tweak IPC.
2. Main performs authoritative validation.
3. The bridge atomically replaces the next-launch snapshot.
4. The current process environment remains unchanged.
5. The page compares the saved snapshot with the applied snapshot. A difference produces a `重启后生效` state.

### Disable and restore

- Turning off the internal switch saves `enabled: false`; the values remain editable and preserved.
- Globally disabling the Tweak also makes its snapshot ineligible at the next launch.
- A normal full exit followed by a fresh OS launch naturally starts from the caller's environment and applies no
  disabled overlay.
- Before a bridge-requested relaunch, Claude++ restores every captured key to its exact incoming state and only then
  schedules the relaunch. This prevents the replacement process from inheriting the old override.
- Restoring a key means assigning the captured original string or deleting the key if it was originally undefined.

## Settings Page

The Claude++ sidebar displays `GPT Context Window` under **TWEAKS** using the same page-registration and navigation
contract as existing Tweak pages.

The page contains:

- internal switch: `启用 GPT 上下文配置`;
- integer input: `最大上下文 Token`;
- integer input: `自动压缩窗口 Token`;
- integer input: `自动压缩阈值百分比`;
- the corresponding environment key below each input;
- one primary `保存` button.

The page shows two distinct states:

- **本次启动已应用:** the overlay actually applied to the current Claude process, or `当前使用原始环境`;
- **重启后生效:** shown when the saved next-launch snapshot differs from the applied snapshot.

After a successful changed save, present the Codex++-style restart choice:

- `稍后`
- `退出并重启 Claude`

No reset-to-defaults or server-compaction control is added in the first version.

## Error Handling

- **Invalid input:** show an inline reason next to the relevant input and reject the whole save.
- **Unreadable, malformed, unsupported-version, partial, or ownership-invalid snapshot:** apply none of its keys, keep
  the incoming environment, log a diagnostic, and show the failure on the settings page.
- **Key ownership conflict:** skip every complete snapshot involved in the conflict and identify all Tweak IDs in the
  log.
- **Startup bridge failure:** fail open for Claude availability but closed for overrides. Claude continues with the
  incoming environment.
- **Main IPC or storage failure:** preserve the last valid saved snapshot and report the error without changing the
  current process.
- **Restart failure:** keep the saved snapshot and instruct the user to quit and reopen Claude manually.
- **Tweak stop/hot reload:** unregister settings UI, listeners, and every IPC handler. No handler from a stopped lease may
  remain callable.

Diagnostics must include Tweak IDs and key names but not log environment values, because the bridge is generic and a
future Tweak could use sensitive values.

## Security and Compatibility

- Early startup runs only Claude++ code and parses declarative data; it never imports Tweak JavaScript before Claude's
  original entry.
- Only manifests with `startup-environment` permission may create or update a snapshot.
- Only manifest-declared keys may be stored or applied.
- File paths are derived from validated Tweak IDs and must remain inside the Claude++ user root.
- All early parsing and application is synchronous and bounded; no network or subprocess work occurs before the host
  entry.
- Safe Mode disables startup overlays as well as ordinary Tweak loading.
- Existing Tweaks without the new permission retain their current lifecycle and behavior.
- The feature is process-wide by design. It does not claim per-model isolation.

## Testing

### Claude++ core tests

- Loader integration test with a fake Claude original entry that records all three values and proves they are visible
  before the original entry executes.
- Permission and manifest-schema tests for valid declarations, missing permission, missing declaration, invalid names,
  duplicate keys, and cross-Tweak conflicts.
- Gate matrix for Safe Mode, global Tweak enablement, internal enablement, missing Tweak source, and valid/invalid
  snapshots.
- Atomic persistence tests, including failed replacement preserving the previous valid document.
- Baseline tests for originally undefined, empty, and non-empty variables.
- Relaunch tests proving the baseline is restored before scheduling the replacement process.
- Fail-closed tests for malformed JSON, unknown versions, partial variables, undeclared keys, and startup exceptions.
- API lease tests proving a disposed Tweak cannot read, write, or request restart through a retained reference.
- Regression tests proving ordinary Tweaks still start after `app.whenReady()` and are otherwise unchanged.

### Tweak tests

- Default configuration, including the initially disabled internal switch.
- Every integer boundary and the cross-field compact-window relationship.
- Renderer load/save flow, inline errors, applied-versus-saved status, and restart prompt.
- Main-side authoritative validation against a bypassed Renderer.
- IPC registration and complete disposal on stop/hot reload.
- Corrupt snapshot and Main API failure presentation.

### Manual acceptance on the managed Claude build

1. Install the Junction and enable the Tweak globally.
2. Enable the internal switch with defaults and choose `退出并重启 Claude`.
3. Confirm the page reports all three defaults under `本次启动已应用`.
4. Create a new session and resume an old session; confirm both use the same launch configuration.
5. Save changed values and choose `稍后`; confirm the applied status remains unchanged.
6. Restart and confirm the changed values become the applied status.
7. Turn off the internal switch, restart, and confirm `当前使用原始环境`.
8. Repeat with a pre-existing incoming value to confirm exact restoration rather than unconditional deletion.
9. Run a long GPT-routed session through CC-Switch and confirm Claude's client-side automatic compaction remains
   functional. Do not label or report it as server-side compaction.

## Delivery Boundaries

Claude++ core changes and the Tweak repository are versioned independently. The Tweak declares the minimum Claude++
runtime version that first exposes `startup-environment`; installation must reject or clearly diagnose an older runtime.

The Tweak repository follows the same source/Junction model used by Unity Links and Feishu Tweaks. Development edits
remain in `D:\workspace\sgproj\FilePackages\gpt-context-window`; the installed Claude++ Tweak directory is only a
Junction and is not a second source of truth.
