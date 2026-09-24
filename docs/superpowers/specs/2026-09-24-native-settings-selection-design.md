# Native Settings Selection Restoration

**Date:** 2026-09-24
**Status:** Implemented and regression-tested; live appearance requires reopening Claude++

## Problem and success condition

The Claude Settings adapter suppresses the native selected row while a Claude++ page is visible. A native click
normally lets Claude render its selection again, but `restoreNative()`, removing the active registered page, and
`stop()` can return the native content without that click. The matching native row must regain its highlight and
`aria-current`, without overwriting a newer selection or unrelated class changes made by Claude.

## Approved Codex++ difference

The inspected reference is `packages/runtime/src/preload/settings-injector.ts` in the canonical local Codex++ checkout
at `D:/Unity/codex-plusplus/codex-plusplus`. Its `syncCodexNativeNavActive(false)` deliberately does nothing, relying on
the native React render after a click.

On 2026-09-24 the user explicitly replied **“允许”** to retaining and restoring native selection in Claude++ instead.
This authorizes transient adapter-owned bookkeeping for the native selection that the adapter suppresses. It fixes
programmatic returns and adds lifecycle cleanup when the Settings DOM changes. It does not authorize altering
Codex++, persistent settings, the public SDK, host React state, or dispatching synthetic native navigation clicks.

## Behavior

- Capture the native selected control and the selection tokens / `aria-current` before suppressing them.
- Restore only the selection-related state that the adapter suppressed; retain unrelated host classes.
- If Claude has already selected a native row on return, keep that newer selection.
- If a new native selection is observed while a Claude++ page remains active, remember the latest observed selection.
- A click on that same native row also restores it, because Claude may skip rendering an unchanged selection. A click
  on another native row leaves the new selection to Claude.
- Keep state through ordinary synchronization and injected-page changes. Reconcile it when the native navigation or
  Settings shell is replaced; never apply detached-element state to a new native row by matching labels.
- Restore on explicit return, active-page removal, and adapter stop. Repeated cleanup must be harmless.
- DOM observations must settle without a mutation loop.

## Scope and verification

Implementation belongs in `packages/runtime/src/preload/claude-settings-shell-adapter.ts` with focused runtime tests.
The prior Windows package launcher and sidebar style fixes remain intact. Add no dependency, persisted file, SDK
field, or version bump. Run focused red/green tests, then the repository's `npm test`, and review the changes before
syncing the local installation. Live appearance remains subject to reopening Claude++ after deployment; do not stop
the user's active app automatically.
