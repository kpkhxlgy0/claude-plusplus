# Watcher Opt-In Divergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently record and verify Claude++'s approved decision to keep the Windows auto-repair Watcher opt-in.

**Architecture:** Preserve the existing installer, CLI, state, Doctor, and scheduled-task behavior without source-code
changes. Add the approved design and this active plan as the durable divergence record. Use the existing focused tests
and full suite for the behavior they cover, inspect source for the uncovered repeated-enable and incomplete-expected
Doctor contracts, and record those two focused test gaps. This documentation-only decision does not add tests.

**Tech Stack:** Markdown, TypeScript, Node.js 24+, Node.js built-in test runner, Windows scheduled tasks.

**Spec:** `docs/superpowers/specs/2026-08-20-watcher-opt-in-design.md`

## Global Constraints

- Claude++ normal install and maintenance must not create or silently enable Watcher scheduled tasks.
- Users enable or disable the Watcher only through `claudeplusplus watcher enable` and
  `claudeplusplus watcher disable`.
- Maintenance must preserve the existing Watcher state.
- Doctor must accept an intentionally absent Watcher and reject an incomplete expected Watcher.
- The managed Windows Store app mirror remains aligned with Codex++; only the Watcher default is an approved
  divergence.
- Do not change Runtime, SDK, Loader, installer behavior, versions, package contents, update channels, or release
  metadata.
- Do not commit, push, tag, or publish without explicit user authorization for that action.

---

### Task 1: Record and verify the approved Watcher policy

**Files:**
- Create: `docs/superpowers/specs/2026-08-20-watcher-opt-in-design.md`
- Create: `docs/superpowers/plans/2026-08-20-watcher-opt-in.md`
- Verify only: `packages/installer/src/commands/install.ts`
- Verify only: `packages/installer/src/commands/repair.ts`
- Verify only: `packages/installer/src/commands/doctor.ts`
- Verify only: `packages/installer/src/commands/watcher.ts`
- Test: `packages/installer/test/commands.test.ts`
- Test: `packages/installer/test/watcher.test.ts`
- Test: `packages/installer/test/self-update.test.ts`
- Test: `test/repository-shape.test.mjs`

**Interfaces:**
- Consumes: Codex++ 1.0.0 commit `f98e7e9d1fa068dde9e0dddfb43b128acb4e2fd7`, Claude++
  `installClaudePlusPlus(...)`, `repairClaudePlusPlus(...)`, `doctorClaudePlusPlus(...)`, and
  `runWatcherCommand(...)`.
- Produces: one approved design record and one active implementation plan; no executable interface or behavior
  changes.

- [x] **Step 1: Reconfirm the Codex++ reference before accepting the record**

Inspect the installed Codex++ source and confirm both default-enabling expressions remain present:

```powershell
rg -n -F '.option("--watcher", "Install the auto-repair watcher", true)' `
  C:\Users\Admin\.codex-plusplus\source\packages\installer\src\cli.ts
rg -n -F 'const wantWatcher = opts.watcher !== false' `
  C:\Users\Admin\.codex-plusplus\source\packages\installer\src\commands\install.ts
```

Expected: each command prints exactly one matching source line. If the installed Codex++ reference has changed, stop
and compare the new behavior before editing the Claude++ record.

- [x] **Step 2: Confirm the design records the complete approved boundary**

Read `docs/superpowers/specs/2026-08-20-watcher-opt-in-design.md` and verify it explicitly contains all of these
decisions:

```text
Codex++ enables its Watcher by default.
Claude++ keeps Watcher installation explicitly opt-in.
The managed Windows app mirror is aligned and is not part of the divergence.
Normal install creates no Watcher task.
Maintenance preserves existing Watcher state.
Explicit enable and disable own scheduled-task mutation.
Doctor distinguishes optional absence from incomplete expected state.
The user approved retaining the difference on 2026-08-20.
```

Expected: every statement is unambiguous, with no unfinished marker or unstated behavior change.

- [x] **Step 3: Run focused behavioral verification**

```powershell
node --import tsx --test `
  packages/installer/test/commands.test.ts `
  packages/installer/test/watcher.test.ts `
  packages/installer/test/self-update.test.ts `
  test/repository-shape.test.mjs
```

Expected: exit code 0. The output must include passing coverage for a fresh install recording `watcher: "none"`,
maintenance preserving an enabled Watcher, one explicit task creation and explicit removal, Watcher-mode refresh
failing closed, and Doctor reporting `optional; not installed`. Repeated-enable idempotence and Doctor rejection of an
incomplete expected Watcher remain source-inspected behaviors without focused automated regression coverage.

- [x] **Step 4: Run the complete repository test suite**

```powershell
npm test
```

Expected: exit code 0 with 348 tests passing and zero failures, skips, or cancellations.

- [x] **Step 5: Verify documentation-only scope**

```powershell
git diff --check
$paths = @(
  'docs/superpowers/specs/2026-08-20-watcher-opt-in-design.md',
  'docs/superpowers/plans/2026-08-20-watcher-opt-in.md'
)
$trailingWhitespace = Select-String -Path $paths -Pattern '[ \t]+$'
if ($trailingWhitespace) {
  $trailingWhitespace
  throw 'Watcher decision documents contain trailing whitespace.'
}
git status --short
```

Expected: `git diff --check` and the trailing-whitespace check emit no output. Status lists only the two new Markdown
files; no Runtime, SDK, Loader, installer, test, version, package, Store, or release file is modified.

- [ ] **Step 6: Commit only after explicit authorization**

```powershell
git add -- `
  docs/superpowers/specs/2026-08-20-watcher-opt-in-design.md `
  docs/superpowers/plans/2026-08-20-watcher-opt-in.md
git commit -m "docs: record opt-in Watcher divergence"
```

Expected: one documentation-only commit containing exactly the design and plan. Do not push, tag, or publish unless
the user separately authorizes those actions.
