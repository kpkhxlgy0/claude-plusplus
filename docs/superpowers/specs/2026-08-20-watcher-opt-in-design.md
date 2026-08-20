# Watcher Opt-In Divergence Design

## Decision

Claude++ keeps the Windows auto-repair Watcher explicitly opt-in. A normal install or maintenance install must not
create scheduled tasks. Users enable or disable the Watcher only through `claudeplusplus watcher enable` and
`claudeplusplus watcher disable`.

This is an intentional, approved difference from Codex++ rather than a temporary parity gap. The user approved
retaining this difference on 2026-08-20.

## Codex++ Reference

The inspected Codex++ 1.0.0 implementation at commit
`f98e7e9d1fa068dde9e0dddfb43b128acb4e2fd7` enables its Watcher by default during installation. Its installer CLI
declares the `--watcher` option with a default of `true`, and the install flow treats every value other than explicit
`false` as a request to install the Watcher.

Claude++ keeps the rest of the relevant Windows installation shape aligned with Codex++: it patches a managed Store
app mirror instead of the official Windows package. The approved difference is the Watcher default, not the managed
mirror architecture.

## Rationale

Claude++ uses opt-in Watcher installation so a normal install does not silently add logon or recurring background
tasks. This keeps automatic maintenance and release refresh under an explicit user decision and makes the default
installed state easier to inspect.

The tradeoff is deliberate: after a supported Claude Desktop package changes, users without the Watcher may need to
run `claudeplusplus repair` or install a newer Claude++ release manually. Claude++ must not conceal that tradeoff or
describe automatic repair as active when the Watcher is absent.

## Lifecycle Contract

- A fresh normal install records the Watcher as `none` and creates no Watcher command script or scheduled task.
- A maintenance install preserves the existing Watcher state; it does not enable a previously absent Watcher.
- `claudeplusplus watcher enable` creates the logon and five-minute scheduled tasks and records the resulting state.
- `claudeplusplus watcher disable` removes the current and known legacy tasks plus the generated command script.
- Watcher-triggered maintenance respects the persisted automatic-refresh setting and fails closed when refresh is
  disabled.
- Doctor treats an absent Watcher as healthy when the persisted installation does not expect one. If state says the
  Watcher is installed, Doctor requires the script and both scheduled tasks.
- Uninstall attempts Watcher cleanup even when the main installer state is missing.

## User Experience

The README must continue to state that Watcher and automatic refresh are off by default. CLI help exposes the explicit
`watcher enable|disable|status` commands and describes the scheduled tasks as optional. Enabling the Watcher must
remain a separate, explicit command. Claude++ must not add an install prompt whose default answer enables it, infer
consent from update-channel selection, or enable it as a side effect of repair.

Generic `status` reports the managed installation without a Watcher field. `watcher status` reports the observed
Watcher inspection result without labeling absence as optional or expected. Doctor owns the expectation-aware
distinction: it accepts an intentionally absent Watcher and reports `optional; not installed`, but reports
`configured but incomplete` and fails its Watcher check when persisted state expects missing Watcher artifacts. Error
and recovery guidance should direct users to `watcher enable`, `watcher disable`, or manual `repair` without changing
state automatically.

## Maintenance Impact

This divergence adds a permanent comparison point whenever Codex++ changes installation or Watcher behavior. Future
Claude++ installation work must inspect the current Codex++ implementation, preserve this opt-in boundary unless the
user explicitly approves another decision, and keep the CLI, README, Doctor, state migration, and tests consistent.

The default creates less background state but increases support responsibility for manual recovery after Claude
Desktop updates. Release notes should call out `repair` when a host update requires it; they must not imply that every
installation repairs itself automatically.

## Verification

Current automated coverage proves that:

- ordinary install and maintenance do not create or silently enable Watcher tasks;
- one explicit enable creates the command script, logon task, and five-minute task;
- repeated enable removes every current and legacy task variant before recreating only the current task pair;
- explicit disable removes current and legacy Watcher artifacts;
- maintenance preserves an enabled Watcher across a new Claude package;
- Watcher-mode repair is a no-op while the managed installation is current;
- Doctor accepts an intentionally absent Watcher and reports `optional; not installed`;
- Doctor rejects a persisted expected Watcher whose artifacts are incomplete and reports `configured but incomplete`.

The repeated-enable and incomplete-expected Doctor contracts were initially source-inspected test gaps. Follow-up
regression tests added on 2026-08-20 now exercise both behaviors. Each test was mutation-checked against the specific
regression it protects before the complete 350-test suite passed.

This decision does not require a Runtime, SDK, Loader, installer-behavior, version, or release-package change. Its
implementation work is limited to preserving the existing behavior, recording the approved divergence, and adding
focused regression coverage.
