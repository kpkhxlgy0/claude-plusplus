# Visible Review-Only Updates Design

**Date:** 2026-08-22
**Status:** Approved design; implementation planned
**Reference:** Installed Codex++ v1.0.0 source under `C:\Users\Admin\.codex-plusplus\source`

## Purpose

Complete Claude++'s already-shipped advisory update surfaces so users can see newer Claude++ releases, newer GitHub
releases for installed Tweaks, and reviewed Store changes without opening each page and checking manually. The feature
automatically downloads only release metadata and the reviewed Store registry. It never downloads a release archive or
executable, installs an update, enables the Watcher, or changes automatic-refresh settings without a separate explicit
user action.

The design follows Codex++ for trigger timing, visible placement, caching, and review-only actions. Five narrowly
scoped differences were explicitly approved by the user on 2026-08-22:

1. automatic advisory-cache persistence must not overwrite a present malformed, non-object, or unreadable
   `config.json`, and a cache-write failure must not prevent Renderer Tweaks from starting;
2. concurrent checks for the same installed Tweak identity must share one in-flight result;
3. Stable and Prerelease product checks keep using the official Claude++ repository and existing release-list
   selection, while only Custom uses its saved repository;
4. parallel advisory completions re-read and merge the latest valid config at commit time rather than persisting a
   request-start snapshot, preserving distinct cache slots and unrelated configuration;
5. the explicit Config-page `Check Now` action uses the same validity-aware advisory-cache writer as automatic checks.

## Goals

- Invoke the existing installed-Tweak GitHub release checker from the production catalog path.
- Preserve Codex++'s parallel, awaited catalog checks and existing 24-hour cache and eight-second request timeout.
- Show a Claude++ `Update` review action beside the `CLAUDE++` Settings group heading when a newer product release is
  available.
- Warm the reviewed Tweak Store when the Settings surface first becomes visible in a Renderer process and show its
  existing installed-update count before the Store page is opened.
- Keep every update action advisory until the user explicitly opens a release, installs a Store entry, or starts the
  existing Claude++ update command.
- Contain product/Tweak metadata, persistence, replaced-Renderer, and detached-DOM failures without breaking Settings
  or Renderer Tweak startup. Automatic Store-warm rejection handling remains exactly as in Codex++.
- Preserve the approved opt-in Watcher policy and all existing update-channel choices.

## Non-goals

- Enabling the Watcher or automatic refresh by default.
- Automatically downloading or installing Claude++ or Tweak release archives.
- Installing arbitrary GitHub release assets; installed-Tweak checks remain release-review links only.
- Adding a notification service, toast, scheduled background process, polling timer, or operating-system notification.
- Moving installed-Tweak checks off the Renderer catalog critical path. A non-blocking background design would be a
  separate approved lifecycle divergence.
- Refreshing the Store registry on every Settings reopen. The Store remains Renderer-memory cached until manual
  refresh, successful Store installation, or Renderer restart.
- Changing Store identity, local-change, downgrade, or installation rules. The badge continues to use the Store page's
  existing installed-version-versus-approved-version mismatch definition.
- Aligning Claude++'s product source selection with Codex++'s saved-repository behavior. Stable and Prerelease remain
  official-only because that is also the actual Claude++ updater contract.
- Changing the existing product channel/repository cache key, prerelease comparison, or core-version comparison rules.
- Implementing full semantic-version precedence for prerelease/build suffixes.
- Adding cross-identity latest-wins arbitration for overlapping Tweak checks. Different identities do not join, but
  persisted id-keyed state retains Codex++'s last-completion behavior.
- Adding latest-wins or cancellation semantics between an automatic Store warm and manual force Refresh. The existing
  renderer-local Store cache retains its last-completion behavior.
- Adding Codex-only Manager, Owl, browser, native-host, or second-catalog surfaces.

## Codex++ Reference Behavior

The inspected Codex++ v1.0.0 implementation provides the reference behavior:

- `packages/runtime/src/main.ts:565-575` awaits `Promise.all` over discovered Tweak release checks before returning
  `codexpp:list-tweaks`.
- `packages/runtime/src/main.ts:1066-1097` keys the persisted 24-hour Tweak cache by Tweak id, repository, and installed
  version.
- `packages/runtime/src/main.ts:1099-1142` bounds each GitHub request with an eight-second abort and turns network/HTTP
  failures into advisory error results.
- `packages/runtime/src/preload/settings-injector.ts:401-450,1984-2043,2939-2993` checks for a Codex++ product update when
  the Settings navigation group is created or recovered after a remount in a visible sidebar candidate, but returns
  early when its owned group is already attached. It shows a group-header `Update` pill for a newer release, falls back
  to the official releases page when the result lacks a URL, and leaves click rejection without a local handler.
- `packages/runtime/src/preload/settings-injector.ts:707-720,1668-1693` warms the Store on the hidden-to-visible
  Settings transition, reuses an in-memory result or in-flight request, and deliberately has no local rejection
  handler on the automatic warm path.
- `packages/runtime/src/main.ts:1033-1048,1099-1134` uses the saved update repository for every channel, calls
  `/releases/latest` for Stable, and calls the release-list endpoint only for Prerelease.

Codex++ Renderer startup also awaits its `list-tweaks` IPC, so a stale release cache can delay Renderer Tweak startup.
Claude++ retains that timing. The approved differences are limited to the five boundaries recorded above and detailed
below; other reference behavior in this scope remains unchanged.

## Terminology and User Promise

“Review-only” describes the update action, not the absence of network traffic. Automatic checks send HTTPS requests to
GitHub and the configured Store registry and download JSON metadata. A GitHub request exposes ordinary connection
metadata and identifies the relevant repository; the current User-Agent also contains the installed Tweak or Claude++
version.

The product promise is:

- metadata may be checked automatically at the triggers below;
- a visible indicator only reports a candidate update;
- clicking the Claude++ or installed-Tweak indicator opens a GitHub release page;
- Store installation and Claude++ self-update remain separate explicit actions;
- no check enables the Watcher, automatic refresh, or installation.

## Architecture Overview

```text
Renderer catalog request
  -> Main snapshots installed Tweaks
  -> selects candidates with an existing entry, including runtime-incompatible rows
  -> starts one check per distinct Tweak identity, all in parallel
  -> same-identity concurrent callers share one result
  -> advisory cache persistence is validity-aware and best-effort
  -> Main returns the catalog with the current batch's fresh results attached
  -> Renderer starts/restarts Tweaks and publishes Settings rows

Settings navigation group mounts or remounts and is visually visible
  -> product release metadata check starts after navigation exists
  -> product result updates controller-owned group-header action

Settings shell becomes visible
  -> Store warm starts independently of product-check timing
  -> Store result updates controller-owned numeric Store badge
  -> Renderer remount recreates navigation from controller state
```

Main owns release requests and persisted cache state. Renderer owns Settings navigation lifecycle, visual Store
visibility, short-lived Store caching, and visible indicator state. Renderer never writes update cache files directly,
and the Settings DOM is never the source of truth for an asynchronous result.

## Installed-Tweak Release Checks

### Catalog selection

`claudepp:list-tweaks` first snapshots `listInstalledTweaks()`. It schedules release checks for every candidate whose
entry exists, including candidates whose `minRuntime` is incompatible with the current Runtime. Codex++ discovery
requires an existing entry but does not gate release checks on `minRuntime`; Claude++ keeps its extra incompatible
diagnostic rows while applying that same request rule. Missing-entry diagnostic rows do not start a request.

Enabled state is not a check gate: disabled and runtime-incompatible entry-present Tweaks remain eligible, matching the
Codex++ discovered-set behavior. Safe Mode continues to omit the Renderer preload, so the normal automatic Renderer
catalog request does not occur on a Safe Mode cold start. The handler itself remains management IPC and does not gain a
separate Safe Mode branch.

All entry-present checks start before any is awaited. The catalog response waits for the slowest distinct request. Each
request retains the existing eight-second abort, so a normal concurrent batch is bounded by the slowest request rather
than eight seconds multiplied by the number of Tweaks.

### Identity and single-flight cache

A Tweak check identity is:

```text
<absolute config file> + <manifest id> + <githubRepo> + <manifest version>
```

The coordinator first accepts a matching persistent result younger than 24 hours. Otherwise it reuses an in-flight
promise for that exact identity. If none exists, it creates one request and stores the resulting promise before
yielding. The in-flight entry is removed after settlement. Repository or version changes use another identity and
cannot join the old request.

The single-flight rule applies only to overlapping requests within one Runtime process. Separate Claude processes and
later sequential calls can independently contact GitHub when no valid persistent result exists. In particular, a
present malformed, non-object, unreadable, or unwritable config is preserved rather than populated with a cache, so a
later sequential catalog request can check again. Documentation must not claim an absolute once-per-24-hours request
maximum.

### Returning fresh results

The list handler attaches the checks returned by the current batch directly to its catalog response. It does not
depend on a successful cache write or a second read to make the current result visible. A missing-entry candidate remains
visible for diagnosis, but receives an existing cached result only when both `repo` and `currentVersion` match its
current manifest; otherwise its update is `null`. This preserves Codex++'s identity-validated attachment semantics for
Claude++'s additional diagnostic rows.

Different identities for the same manifest id do not join one another. As in Codex++, their id-keyed persisted writes
use last-completion behavior: an older request that settles last can temporarily replace the newer identity's cache.
The next check validates repository and installed version before reuse, so the mismatched entry is not accepted as a
24-hour hit. Suppressing such cross-identity writes would be a separate latest-wins divergence and is not part of this
design.

The existing `ListedTweak.update` view and Tweaks-page `Update Available` / `Review Release` UI remain unchanged. This
task activates that shipped surface rather than creating another installed-Tweak update page.

## Advisory Cache Persistence

Product and installed-Tweak advisory checks use a new validity-aware, best-effort Runtime-config mutation path whether
they were started automatically or by the Config page's explicit `Check Now`. Explicit user mutations of enablement,
channels, Safe Mode, Watcher state, or other configuration keep their current behavior and are outside this safety
difference.

The advisory writer follows these rules:

- an absent config file may be created with normalized defaults plus the advisory cache result;
- a present valid JSON object may be normalized and atomically replaced while preserving unknown top-level and nested
  fields through the existing config normalization rules; known fields containing invalid schema values can still be
  normalized exactly as they are today;
- a present malformed JSON document, JSON non-object root, or unreadable file is not rewritten;
- staging or replacement failure is logged and returned as “not persisted”; it is not thrown into the catalog or
  Settings caller;
- staging cleanup remains best-effort and uses the existing same-directory atomic-replacement pattern;
- the check result remains usable by the current awaiting caller or callers even when persistence is refused or fails.

This prevents an advisory metadata operation from replacing a malformed, non-object, or unreadable document and from
blocking on a cache-write failure. It does not promise byte preservation for a syntactically valid object whose known
fields require existing normalization, and it does not change how explicit enable/disable, channel, Safe Mode, or other
configuration mutations report invalid state.

Every advisory completion performs the validity check and read-modify-write against the latest config bytes at commit
time. The mutation and atomic replacement are synchronous within the Main process, so parallel product and distinct-id
Tweak completions serialize on the event loop and preserve one another's cache slots plus intervening in-process config
mutations. Same-id, different-identity Tweak completions still target the one existing `tweakUpdateChecks[id]` slot and
therefore retain the last-completion behavior defined above. The implementation must not persist a config snapshot
captured before awaiting GitHub. Cross-process writers and a hostile same-user file swap remain outside this
process-local merge guarantee.

## Claude++ Product Update Indicator

The existing `claudepp:check-claudepp-update` IPC, channel selection, 24-hour cache, release-note data, and eight-second
timeout remain the authority. Stable and Prerelease always query the official `kpkhxlgy0/claude-plusplus` repository;
only Custom queries its saved repository. Claude++ retains its existing release-list request and local stable/prerelease
selection instead of Codex++'s Stable `/releases/latest` request. This keeps the indicator aligned with the installer,
which rejects non-official Stable/Prerelease repositories. Automatic product checks use `force: false`; the Config
page's explicit `Check Now` continues to force a request while using the same safe advisory-cache writer.

The Claude Settings shell adapter reports both navigation-group mount/remount and surface visibility. Product checks
follow Codex++'s navigation lifecycle: after the `CLAUDE++` group is first attached or recovered/recreated for a remounted
shell, a `force: false` product check starts once that mount is visually visible, without delaying the navigation. If
Claude's hidden dialog DOM is discovered first, the check remains pending until that mounted group first becomes
visible. Direct replacement or remount of one visible shell with another attaches navigation again and therefore checks
again even though visibility never transitioned through false; the Main 24-hour cache normally prevents another GitHub
request. Ordinary observer synchronization and controller-driven navigation-state renders do not report another
product trigger while the owned group remains attached. This matches Codex++'s visible-sidebar candidate and
early-return branches and prevents recursive checks.

Store warming alone uses the strict visual predicate. A shell is visible only when its dialog is connected, computed
`display` is not `none`, computed `visibility` is not `hidden`, and its bounding box has positive width and height. The
adapter extends its existing subtree child-list observer with subtree `class` / `style` / `hidden` / `aria-hidden` /
`open` attribute observation, adds a `ResizeObserver` for the current dialog, and listens for window resize; observer
dependencies remain injectable for tests and no polling timer is added. A visible shell replacement does not create an
artificial hidden-to-visible transition for Store warming.

`SettingsProductController` owns the current product indicator. Both the automatic Settings check and Config-page
`Check Now` publish their completed result through the same controller setter, so the page and group heading agree.
Overlapping automatic and forced checks retain Codex++'s last-completion behavior; this design does not add
latest-request-wins arbitration. When `updateAvailable` is true, the `CLAUDE++` group heading receives a blue `Update`
action with a version-aware accessible title even when `releaseUrl` is missing. Clicking it dereferences the current
controller result and invokes only `claudepp:open-external`, using the current release URL when present and
`https://github.com/kpkhxlgy0/claude-plusplus/releases` otherwise. A current or failed check removes the action. The
fire-and-forget click path deliberately has no local rejection handler, matching Codex++.

The shell adapter gains a generic optional group-header action model rather than product-specific DOM code. The action
callback dereferences controller state when clicked rather than capturing a release URL. Consequently a same-version
result with a different release URL cannot retain an obsolete target even when the navigation identity, label, and
title are unchanged.

## Store Warm and Badge

When the Settings surface first becomes visible in a Renderer process, the Store warm begins. On an initially visible
shell, the navigation-triggered product check and visibility-triggered Store warm both start during the same synchronous
injector setup turn, but they remain separate triggers. The warm uses the existing renderer-local `cachedStore` /
`storePromise` single-flight state and the existing `claudepp:get-tweak-store` Main service. It does not wait before
injecting navigation or opening a native Settings page.

On success, the existing Store mismatch calculation publishes a count to `SettingsProductController`, which renders
the numeric badge on the `Tweak Store` item. Opening the Store reuses the warmed registry. Manual `Refresh` clears the
cache and forces a new request; successful Store installation also clears it before the existing delayed refresh;
Renderer restart clears all renderer-local Store state.

The automatic warm intentionally mirrors Codex++'s local failure semantics: it attaches only a success continuation,
so a rejected Store request is not caught by the warm path. The shared in-flight promise is still cleared in
`finally`, allowing a later visibility transition or Store-page open to retry. A Store-page render failure keeps its
existing explicit error/Refresh UI and clears the visible count. This design does not add a Store TTL and does not
promise a request on every Settings reopen.

The count deliberately retains the current Codex++-aligned mismatch semantics: any installed version unequal to the
approved Store manifest version counts. Correcting newer-local-version downgrade affordances or same-id non-Store
ownership is a separate Store-hardening design and is not implied by this indicator work.

An automatic warm and a manual force Refresh can overlap. This design retains the existing last-completion Store cache
behavior and does not add cancellation or latest-request-wins arbitration. Fixing that narrow race would be a separate
approved Store lifecycle difference.

## Renderer Lifecycle and Hot Reload Impact

Claude++ Renderer startup and reconstruction await `claudepp:list-tweaks`. After this change, the first entry-present check
with no valid persistent cache can delay Renderer Tweak startup by up to the slowest request timeout,
normally about eight seconds. During Renderer reconstruction, the prior Renderer Tweak lifecycle has already stopped
and Settings registrations have been cleared before the catalog request, so a stale-cache hot reload can temporarily
leave Renderer Tweak UI absent for the same period.

Once results are successfully persisted, normal list and hot-reload calls perform no network request and return after
local cache work until expiry. Malformed, non-object, unreadable, or unwritable config is deliberately not populated,
so a later sequential call can check again. This blocking lifecycle is retained because it is Codex++ reference
behavior and the user selected it over a non-blocking background refresh. Main Tweak startup ordering and Runtime's
Chokidar debounce are unchanged.

## Asynchronous State and Error Handling

- GitHub 404, non-success status, timeout, and request rejection remain advisory `error` results with
  `updateAvailable: false`.
- A network error for one Tweak does not reject another check or the catalog. A persistence error never rejects the
  catalog.
- Product and Store indicator completions update controller state only if they still belong to the current Settings
  environment generation. An old environment cannot update a new controller or detached DOM.
- Automatic and forced product checks update controller and persisted state in completion order. No request-generation
  priority is implied.
- Automatic Store warm rejection is not caught locally, matching Codex++; its in-flight state still clears so a later
  visibility transition, page open, or manual Refresh may retry. Store-page render failure remains caught and clears
  the count.
- Product IPC rejection is caught and hides the group-header action. The Config page remains available for a manual
  retry and detailed result.
- Product action clicks and automatic Store warm have no local rejection handler, matching Codex++; product-check IPC
  rejection and explicit Store-page rendering remain caught at their reference-aligned boundaries.
- Navigation is always built before a product check starts or Store metadata completes.
- Indicator clicks use the existing GitHub-only external-URL gate. No metadata result can supply a command line,
  executable path, or automatic installation action.

## Data and Interface Changes

No new persistent file or public SDK field is introduced.

- `config.json` retains `claudePlusPlus.updateCheck` and `tweakUpdateChecks` in their existing shapes.
- Runtime config adds an internal advisory-cache mutation result that distinguishes persisted, refused-invalid, and
  write-failed outcomes without exposing those states to Tweak authors.
- Tweak update coordination adds an internal process-local in-flight map keyed by check identity.
- Advisory cache commits synchronously re-read and merge the latest valid config; they never write a request-start
  snapshot after an asynchronous fetch. Distinct product/Tweak slots survive, while same-id Tweak identities retain
  the existing single-slot last-completion rule.
- `ManagementIpcDeps` and Runtime bootstrap gain an injected Tweak-check dependency for deterministic tests; production
  defaults to the real coordinator.
- `SettingsNavigationGroup` gains an optional generic header action.
- The Claude Settings shell adapter environment supplies computed-style and geometry access plus injectable attribute,
  resize, and window-resize observation, and reports navigation-group mount/remount separately from defined
  visible/hidden transitions to the Settings injector.
- `SettingsProductController` gains product-update state and a setter; the Config page context can publish a forced
  check through that setter, while Store count remains its existing state.
- Store page exports a warm operation backed by the same cache and in-flight request as normal rendering.
- The installed-Tweak request path accepts an internal timer scheduler/abort dependency. Production uses the real
  eight-second timer; tests capture and trigger the scheduled abort without wall-clock waiting.

No management channel is added for automatic archive download, installation, Watcher mutation, or scheduled work.

## Documentation

Update the author-facing distribution guide and user-facing update documentation to say:

- installed-Tweak release metadata can be requested during Renderer startup and hot reload;
- every entry-present installed Tweak is checked even when runtime-incompatible or disabled; missing-entry diagnostic
  rows do not start a request;
- requests are concurrent and may delay the first stale-cache Renderer Tweak start for about eight seconds;
- a matching persistent result is reused for 24 hours and overlapping same-identity requests share one promise, while
  separate processes or later calls without usable persisted state can check independently;
- Stable and Prerelease product indicators use the official Claude++ repository, while Custom uses its saved
  repository;
- product metadata begins when a newly mounted/remounted Claude++ Settings navigation group is visually visible; a
  hidden mount defers its check until first visibility. Store metadata begins on each false-to-true visually visible
  transition in a Renderer process;
- a product update with no release URL still opens the official Claude++ releases page, and its fire-and-forget click
  path has no local rejection handler, matching Codex++;
- Store memory is reused until manual Refresh, successful Store installation, or Renderer restart;
- automatic Store warm has no local rejection handler, matching Codex++; explicit Store-page load failure is caught,
  clears the badge, and keeps the page's error/Refresh state;
- the Config page's manual `Check Now` publishes through the same product-indicator state and uses the same
  validity-aware advisory-cache writer as automatic checks;
- parallel advisory completions for distinct persisted slots merge into the latest valid config instead of writing
  request-start snapshots; same-id Tweak identities retain their documented single-slot last-completion behavior;
- automatic traffic downloads metadata only and never downloads a release archive or installs it;
- Watcher and automatic refresh remain off by default.

Release notes must describe the indicators as advisory and must not say “no automatic download” without qualifying
that metadata JSON is downloaded.

## Test Requirements

Tests follow red-green-refactor and use injected clocks, requests, persistence, IPC, and Settings environments. They do
not contact GitHub, alter the live user profile, wait eight wall-clock seconds, or enable the Watcher.

### Main and Tweak coordinator

- Three stale entry-present Tweaks, including one runtime-incompatible row, start all distinct requests before any
  resolves; the list response remains pending until all settle and contains those fresh results.
- Matching cache at `24h - 1ms` is reused; exactly 24 hours, repository change, and version change create a new check.
- Two concurrent list calls for the same config/id/repository/version share one request and both receive the same
  result.
- When persistence is refused, the in-flight entry is removed after settlement and a later sequential call in the same
  process creates a second request instead of reusing a settled-memory result.
- Different identities do not share a promise, and each current caller receives its own completed result. If their
  id-keyed persisted writes overlap, the last completion may remain on disk; a later caller rejects that cache when its
  repository or installed version does not match.
- Disabled and runtime-incompatible entry-present Tweaks are checked; missing-entry candidates are not.
- Missing-entry diagnostic rows attach a cached check only when its repository and installed version match the current
  manifest; a different-identity id-keyed cache is exposed as `null`. Runtime-incompatible entry-present rows receive
  the current batch result.
- HTTP 404, non-success status, timeout, request rejection, refused-invalid persistence, and write failure return a
  catalog rather than rejecting Renderer startup.
- A present malformed or non-object config remains byte-for-byte unchanged after automatic product and Tweak checks;
  an injected unreadable-config failure proves replacement is not attempted.
- A missing config can persist a cache. A valid object preserves unrelated and unknown keys, while invalid known fields
  retain the existing normalization behavior rather than receiving a byte-preservation guarantee.
- Three distinct-id Tweak completions plus a product completion all survive in the final config, together with an
  intervening in-process config mutation made while their requests are pending. A separate same-id/different-identity
  case proves the retained one-slot last-completion rule.
- Test dependencies prove current-batch results are attached directly even when persistence is unavailable.
- The injected timer scheduler captures the eight-second timeout and triggering its callback aborts the request without
  waiting eight wall-clock seconds.
- With a stale cache or `force: true`, Stable and Prerelease requests use the official repository even when a saved
  Custom repository remains in config; Custom uses that saved repository. Stable and Prerelease both use the existing
  release-list endpoint and their existing local release-selection rules.

### Settings shell and product indicator

- Mounting/remounting the Claude++ navigation group while `display: none`, `visibility: hidden`, or zero-area starts
  neither request; the mount's first positive visual predicate starts both the pending product check and Store warm.
- Attribute-observer, resize-observer, and window-resize test doubles each drive predicate re-evaluation; visibility
  tests exercise those public observer signals rather than directly invoking an internal synchronization function.
- For an initially visible shell, navigation is injected first, then product and Store metadata work both start before
  the injector setup turn returns.
- MutationObserver noise does not create duplicate visibility transitions or duplicate buttons. Removing a shell
  produces a hidden state, while replacing one visible shell directly with another does not invent an intermediate
  hidden-to-visible trigger.
- A same-shell observer turn with unchanged navigation performs no same-value write to the observed `class` attribute
  and does not queue a MutationObserver feedback loop.
- A direct visible-shell replacement remounts navigation and checks product metadata again while Store visibility
  remains continuously true and therefore does not warm again. Same-shell observer noise and visibility changes do not
  check product metadata again after that mount's product check has started while the owned group remains attached.
- Update available adds exactly one group-header action with an accessible version title; a missing release URL keeps
  the action and clicking it opens the official releases page; current/error results remove it.
- The Config page's forced `Check Now` updates the same controller and group-header action. Malformed, non-object, or
  unreadable config still follows the validity-aware refusal path while the completed advisory result remains visible.
- Overlapping automatic and forced product checks publish in completion order, documenting the retained
  last-completion behavior.
- If controller state changes to the same version with a different validated release URL, clicking the unchanged action
  opens the current URL rather than one captured by its original render.
- Clicking the action invokes only the GitHub external-open IPC and never run-update, Store-install, Watcher, spawn, or
  archive paths. Its source shape has no local rejection handler; do not execute an intentional rejection in the Node
  test runner.
- A deferred result from a disposed Settings environment cannot update the replacement controller or detached DOM.

### Store warm and packaging regression

- Warm and page render share one normal in-flight Store request.
- Successful warm publishes the existing mismatch count before the Store page opens.
- Store-page render failure is contained, hides the count, and permits a later retry. Automatic warm rejection is not
  caught locally, matching Codex++, while its in-flight state still clears for a later retry.
- An overlapping automatic warm and forced Refresh retain last-completion cache behavior; no latest-request-wins claim
  is made.
- Successful Store installation clears the renderer-local Store cache before keeping the existing decrement and
  delayed refresh behavior.
- Runtime and portable Windows builds continue to bundle the Settings/Runtime changes without adding another package
  dependency or management namespace.

Focused Runtime suites, the Runtime build, the complete `npm test` suite, Windows packaging, and the portable package
smoke test are required before release. Package smoke remains profile-redirected and must not contact the user's live
Claude++ directories.

## Approved Differences from Codex++

The user explicitly approved these differences on 2026-08-22:

1. **Validity-aware best-effort automatic cache persistence.** Codex++ reads invalid state as `{}` and can replace it
   with advisory cache data; Claude++ refuses to rewrite present malformed, non-object, or unreadable config bytes.
   Codex++ also swallows state-write failures; Claude++ matches the non-blocking outcome while retaining atomic writes
   for valid state. User-visible impact: update indicators may be available only to current callers and may be checked
   again by a later call or process, but automatic advisory work cannot replace malformed, non-object, or unreadable
   configuration or prevent Renderer Tweaks from starting.
   Maintenance impact: automatic cache writers must use the validity-aware path, while explicit config mutations keep
   their separately defined behavior.
2. **Per-identity process-local single-flight.** Codex++ can issue duplicate simultaneous GitHub requests for the same
   Tweak identity. Claude++ shares one in-flight promise for the absolute config path, manifest id, repository, and
   installed version, then removes it after settlement. User-visible impact: overlapping Renderer/catalog callers see
   one consistent result with less rate-limit and privacy exposure; later calls without usable persisted state may
   check again. Maintenance impact: identity matching, settlement cleanup, and concurrent-call behavior require
   deterministic tests.
3. **Official product source and existing release-list selection.** Codex++ uses the saved update repository for every
   channel and queries `/releases/latest` for Stable. Claude++ keeps Stable and Prerelease on the official
   `kpkhxlgy0/claude-plusplus` repository, uses the existing release-list selection for both, and uses the saved
   repository only for Custom. User-visible impact: the Settings indicator matches what Claude++ can actually install
   and does not advertise a non-official Stable or Prerelease source. Maintenance impact: product-check and installer
   source rules must remain covered together, and later Codex++ endpoint changes are not inherited automatically.
4. **Commit-time merge of parallel advisory results.** Codex++ can write a state snapshot captured before its network
   request, allowing a later completion to discard another persisted slot. Claude++ re-reads the latest valid config
   and synchronously merges each result immediately before atomic replacement. User-visible impact: concurrent product
   and distinct-id Tweak checks do not silently erase one another or an intervening in-process setting change. The one
   existing slot for same-id/different-identity Tweak checks deliberately retains last-completion behavior. Maintenance
   impact: all advisory writers must use the common commit-time mutation path; the guarantee remains process-local and
   requires deterministic overlapping-request tests for both distinct and shared slots.
5. **Manual `Check Now` uses the safe advisory writer.** The Config page's forced product check joins automatic product
   and Tweak checks on the validity-aware persistence path instead of using the ordinary explicit-config mutation
   contract. User-visible impact: a manual metadata check can still update the visible advisory result but cannot
   replace malformed, non-object, or unreadable config merely to cache it. Maintenance impact: forced and automatic
   checks must publish through the same controller and persistence abstraction, while actual channel, enablement, Safe
   Mode, and Watcher mutations retain their existing behavior.

Everything else in this design preserves the inspected Codex++ product behavior unless an existing approved Claude++
host divergence already applies. In particular, checks remain blocking on the Renderer catalog path, the product
indicator remains a group-header review action, Store warming is tied to Settings visibility, Store mismatch semantics
remain unchanged, and no automatic installation is introduced.

The user reconfirmed strict Codex++ behavior for two audited boundaries on 2026-08-22: release checks include
runtime-incompatible entry-present Tweaks, and the automatic Store warm does not add a local rejection handler. A final
source audit also preserves Codex++'s visually eligible navigation mount/remount product trigger and attached-group early
return, official releases-page fallback for a missing result URL, and lack of a local product-click rejection handler.
These are reference-aligned behaviors, not additional approved differences.

## Success Criteria

- An installed entry-present Tweak, including a runtime-incompatible diagnostic row, can show `Update Available` and a
  working `Review Release` action after the awaited catalog check.
- A newer Claude++ release shows one `Update` action beside the `CLAUDE++` Settings heading; clicking it only opens the
  GitHub release, or the official Claude++ releases page when the result URL is absent.
- Stable and Prerelease indicators use the official repository accepted by the Installer and retain Claude++'s
  release-list selection, while Custom uses its saved repository.
- Reviewed Store version mismatches show a numeric Store badge before the Store page is opened.
- Metadata failures, malformed/non-object/unreadable config, and cache-write failures never prevent Renderer Tweak
  startup; advisory cache writes never replace those present malformed, non-object, or unreadable config bytes.
- Concurrent same-identity Tweak checks share one request, and an unexpired persistent result prevents a later request.
- Parallel product and distinct-id Tweak completions preserve every distinct cache slot and intervening in-process
  config mutation; same-id/different-identity checks retain their documented one-slot last-completion behavior.
- Manual `Check Now` updates the same Settings indicator and retains the validity-aware cache-write guarantees.
- No path downloads or installs a release archive, changes update settings, enables the Watcher, or creates scheduled
  work without a separate explicit user action.
- The opt-in Watcher design, Safe Mode cold-start behavior, Tweak lifecycle order, Store installation safety, and
  existing CLI behavior remain unchanged.
