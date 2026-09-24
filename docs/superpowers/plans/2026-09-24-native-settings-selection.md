# Native Settings Selection Restoration Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement
> this approved plan. Preserve the existing unstaged launcher and sidebar fixes.

**Goal:** Restore the native selected row when Claude++ returns native Settings content without a native click.

**Architecture:** The Settings shell adapter retains only the native selection state it suppresses. Restoration
respects newer host selection and preserves unrelated classes; state is reconciled at the existing shell lifecycle
boundaries. This is the user-approved 2026-09-24 difference from Codex++'s reliance on a native React rerender.

**Tech Stack:** TypeScript, Node.js tests with `tsx`, the existing miniature Settings DOM fixture.

**Spec:** `docs/superpowers/specs/2026-09-24-native-settings-selection-design.md`

## Constraints and review focus

- No persistent selection cache, synthetic clicks, host React state changes, SDK change, dependency, or version bump.
- A fresh host selection takes precedence over the previously muted row.
- Clicking the previously selected native row restores it even when Claude skips a same-value state update; clicking
  a different native control remains owned by Claude.
- Unrelated class changes survive restoration; a saved whole `className` must not overwrite them.
- Navigation replacement must not transfer detached row state onto a different native control.
- Injected navigation rebuilds in the same shell must retain the suppressed native selection.
- Repeated return, stop, and observer delivery must be idempotent and converge.

## Task 1: Restore selection through the adapter lifecycle

**Files:** `packages/runtime/src/preload/claude-settings-shell-adapter.ts`,
`packages/runtime/test/claude-settings-shell-adapter.test.ts`, and the existing DOM fixture only as needed.

**Interfaces:** Retain `showPanel`, `restoreNative`, `setNavigation`, and `stop` unchanged.

- [x] Add a failing reproduction around the real adapter:

```ts
const fixture = settingsFixture();
const adapter = createClaudeSettingsShellAdapter(fixture.environment);
adapter.start();
adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
adapter.showPanel("config", () => {});
adapter.restoreNative();
assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
adapter.stop();
```

- [x] Run `node --import tsx --test packages/runtime/test/claude-settings-shell-adapter.test.ts`; confirm the new
  assertion fails because the native row remains inactive.
- [x] Record the selected control's selection tokens and original `aria-current` before muting it. Restore these
  through the adapter's return/stop lifecycle only when the native host has not supplied a newer selection. Clear or
  reconcile state at native navigation/shell replacement; do not replace a row's entire class string.
- [x] Add cases for stop and active-page removal; native selection before return and after observer delivery;
  unrelated class mutation; missing original `aria-current`; replaced navigation; injected group rebuild;
  repeated cleanup; and mutation convergence. Assert actual row selection, with native content visibility covered
  by the panel lifecycle tests.
- [x] Add the review-discovered same-native-row click regression and retain different-row selection behavior.
- [x] Run adapter, injector, and product-controller tests together and confirm all pass.

## Task 2: Review, verify, and update the local installation

**Files:** The files above, `CHANGELOG.md`, and these design / plan records.

- [x] Have a read-only reviewer check selection precedence, cleanup boundaries, and observer convergence.
- [x] Run `npm test` from the canonical Claude++ checkout and `git diff --check`.
- [x] Compare the installed source snapshot with the previous deployed state before copying the changed files and
  rebuilt runtime. Use same-version `install` to refresh runtime and shortcut without forcing a locked app-mirror
  replacement.
- [x] Read back installed runtime hashes and `doctor` results. Preserve the running app and report that reopening
  Claude++ is required for live UI verification.

## Verification record (2026-09-24)

- The initial programmatic-return regression failed before implementation (14 pass / 1 fail).
- Injected-group rebuilding exposed a second failing regression (22 pass / 1 fail), fixed by retaining the snapshot
  when the actual native navigation remains unchanged.
- Review found a same-native-row click gap; its test failed before the conditional restoration (24 pass / 1 fail).
- Final focused adapter, injector, and product-controller run: **53 passed, 0 failed**.
- Final canonical `npm test`: build succeeded; **644 passed, 0 failed, 0 skipped**.
- Final independent runtime review: no remaining material findings. `git diff --check` passed.
- Baseline hashes confirmed the installed source had not changed before synchronization. Same-version `install`
  returned `current` for Claude 2.7032.0.0 and refreshed the runtime without restarting the app.
- `doctor`: **12/12 checks passed**. Canonical, installed-source, and deployed preload SHA-256 matched:
  `6b9501aebdbfb5b26dcdeeda4c1fddce3552d7db64fb722a6e4337f28931ef90`.
- At initial implementation handoff, live host appearance required reopening Claude++; no release had been published.

## Release follow-up (2026-09-24)

The user confirmed the local fixes worked and explicitly authorized committing, pushing, and publishing. Release
0.3.4 carries the launcher and sidebar fixes, the approved selection-restoration difference, and synchronized package
versions. The final versioned tree passed 644 tests, Windows packaging and portable-CLI smoke tests, and an isolated
0.3.3-to-0.3.4 upgrade / repair / uninstall against Claude 2.7032.0.0. All 12 Doctor checks passed. The official Claude
executable and ASAR hashes were unchanged, and the temporary verification directories were removed.
