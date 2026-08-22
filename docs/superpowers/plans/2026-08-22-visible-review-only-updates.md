# Visible Review-Only Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface review-only Claude++, installed-Tweak, and reviewed-Store update indicators while preserving Codex++ timing, explicit installation, and Claude++'s five approved safety/source differences.

**Architecture:** Main owns GitHub release requests and validity-aware persisted advisory state; the installed-Tweak catalog awaits parallel checks and returns the current batch directly. Renderer owns Settings navigation mount/remount signals, visual Store visibility, controller-backed product/Store indicators, and the existing Store memory cache. Automatic work fetches JSON metadata only and never invokes installation, Watcher, archive, or scheduled-work paths.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner with `tsx`, Electron 41 Renderer/Main boundaries, DOM `MutationObserver`/`ResizeObserver`, existing atomic JSON config writer, PowerShell Windows packaging.

**Spec:** `docs/superpowers/specs/2026-08-22-visible-review-only-updates-design.md`

## Global Constraints

- Inspect the installed Codex++ v1.0.0 source at `C:\Users\Admin\.codex-plusplus\source` before changing corresponding behavior; preserve the approved spec rather than relying on memory.
- Keep every entry-present installed-Tweak check parallel and awaited by `claudepp:list-tweaks`, including disabled and runtime-incompatible rows; missing-entry rows start no request. A stale or missing persistent cache may delay initial Renderer Tweak start or hot reconstruction by the slowest request, bounded at 8,000 ms.
- A matching installed-Tweak cache is valid for 24 hours only when manifest id, repository, and installed version agree. Same-identity overlapping calls share one in-flight promise; settled results are not retained in a second memory cache.
- Stable and Prerelease product checks always use `kpkhxlgy0/claude-plusplus` and the existing release-list endpoint/local selection. Only Custom uses the saved repository.
- Advisory persistence re-reads the latest valid config at commit time. Distinct product and Tweak-id slots plus intervening in-process config changes survive; same-id/different-identity Tweak writes retain one-slot last-completion behavior.
- Automatic product/Tweak checks and Config-page product `Check Now` use the validity-aware best-effort writer. Explicit enablement, channel, Safe Mode, automatic-refresh, and Watcher mutations keep the existing mutation contract.
- Do not replace a present malformed JSON document, non-object JSON root, or unreadable config merely to cache advisory metadata. A syntactically valid object may retain existing normalization behavior.
- Product metadata starts when a newly mounted/remounted Claude++ Settings navigation group is visually visible; a hidden mount defers until its first visible state, and ordinary synchronization does not retrigger it while the owned group remains attached. Store metadata starts on the same connected, displayed, CSS-visible, positive-area predicate. Navigation injection never awaits either request.
- Product automatic/forced requests and Store warm/forced Refresh retain completion-order behavior; do not add latest-request-wins, cancellation, polling, or a Store TTL.
- Automatic Store warm retains Codex++'s success-only continuation: do not add a local rejection handler or `.catch`; explicit Store-page rendering keeps its existing caught error path.
- The group-header Update action only calls the existing GitHub-only `claudepp:open-external` IPC. A missing result URL falls back to `https://github.com/kpkhxlgy0/claude-plusplus/releases`, and the fire-and-forget click has no local rejection handler, matching Codex++. It must never call product self-update, Store install, Watcher, spawn, archive, or scheduled-work paths.
- Store update count remains `installed.version !== approved manifest.version`. Store memory is cleared by manual Refresh, successful Store install, or Renderer restart.
- Tests use temporary roots and injected requests, clocks, timers, config I/O, IPC, and DOM observer signals. They do not contact GitHub, touch the live Claude++ profile, wait eight wall-clock seconds, or enable Watcher/automatic refresh.
- Add no package dependency, public SDK field, persistent file, management namespace, background process, or version bump in this implementation plan. Draft `CHANGELOG.md` and `docs/releases/0.3.1.md`, but leave every package at `0.3.0`; version/tag/release publication remains a later explicit release step.

## File Ownership and Task Order

| Responsibility | Files |
| --- | --- |
| Validity-aware advisory config commit | `packages/runtime/src/config.ts`, `packages/runtime/test/config.test.ts` |
| Installed-Tweak request/single-flight and cache attachment | `packages/runtime/src/tweak-update.ts`, `packages/runtime/src/tweak-catalog.ts`, corresponding tests |
| Product request source/selection and safe persistence | `packages/runtime/src/update-service.ts`, `packages/runtime/test/update-service.test.ts` |
| Awaited production catalog orchestration | `packages/runtime/src/management-ipc.ts`, `packages/runtime/src/main.ts`, management/concurrency tests |
| Settings navigation/visibility signals and generic group-header action | `packages/runtime/src/preload/{claude-settings-shell-adapter,settings-injector}.ts`, `packages/runtime/test/fixtures/settings-dom.ts`, adapter tests |
| Product controller, automatic check, and Config publication | `packages/runtime/src/settings/{types,product-controller,config-page}.ts`, `packages/runtime/src/preload/settings-injector.ts`, focused tests |
| Store warm and proactive badge | `packages/runtime/src/settings/store-page.ts`, `packages/runtime/src/preload/settings-injector.ts`, Store/injector tests |
| User/author contract and release draft | `README.md`, `CHANGELOG.md`, `docs/tweaks/*.md`, `docs/releases/0.3.1.md`, repository-shape test |

Tasks 1–4 establish Main-side contracts before Renderer consumes them. Task 5 establishes the generic shell contract
before Tasks 6–7 attach product and Store behavior. Task 8 updates the public contract only after behavior is covered;
Task 9 is the non-mutating comparison and release gate.

## Shared Test Helper Contract

When a task uses a deferred promise, add this test-only helper to that task's test file rather than production code:

~~~ts
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
~~~

Fixture names in the task snippets are test-only builders, not proposed production APIs. Each task below specifies the
existing fixture to extend, the fields it must return, and the cleanup it must perform. Response builders use the
platform `Response` class and always set JSON content type; date builders use fixed ISO timestamps so tests are
deterministic.

---

### Task 1: Validity-Aware Advisory Config Mutation

**Files:**
- Modify: `packages/runtime/src/config.ts:55-112`
- Modify: `packages/runtime/test/config.test.ts`

**Interfaces:**
- Produces: `AdvisoryCacheWriteResult` with `persisted`, `refused-invalid`, and `write-failed` states.
- Produces: `AdvisoryConfigIo { readText, writeAtomic }` for deterministic read/write failure tests.
- Produces: `mutateRuntimeConfigAdvisory(path, mutate, options?) => AdvisoryCacheWriteResult`.
- Preserves: `mutateRuntimeConfig` and all explicit configuration mutation semantics.

- [ ] **Step 1: Write failing advisory-writer tests**

Extend the imports and add literal malformed, non-object, missing, valid-normalization, unreadable, and write-failure cases:

~~~ts
import {
  mutateRuntimeConfigAdvisory,
  readRuntimeConfig,
  type AdvisoryConfigIo,
} from "../src/config.ts";

test("advisory mutation refuses malformed and non-object config without replacing bytes", () => {
  for (const original of ["{broken", "[]\n", "null\n"]) {
    const root = mkdtempSync(join(tmpdir(), "claudepp-advisory-invalid-"));
    const file = join(root, "config.json");
    try {
      writeFileSync(file, original, "utf8");
      const result = mutateRuntimeConfigAdvisory(file, (config) => {
        config.claudePlusPlus.updateCheck = productCheck("0.3.1");
      });
      assert.equal(result.status, "refused-invalid");
      assert.equal(readFileSync(file, "utf8"), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("advisory mutation creates a missing config and normalizes a valid object", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-advisory-valid-"));
  const file = join(root, "config.json");
  try {
    const created = mutateRuntimeConfigAdvisory(file, (config) => {
      config.tweakUpdateChecks["com.example.one"] = tweakCheck("com.example.one", "0.1.0");
    });
    assert.equal(created.status, "persisted");

    writeFileSync(file, JSON.stringify({
      claudePlusPlus: { safeMode: "invalid", privateNested: { keep: true } },
      privateTop: { keep: true },
    }), "utf8");
    const normalized = mutateRuntimeConfigAdvisory(file, (config) => {
      config.claudePlusPlus.updateCheck = productCheck("0.3.1");
    });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(normalized.status, "persisted");
    assert.equal(stored.claudePlusPlus.safeMode, false);
    assert.deepEqual(stored.claudePlusPlus.privateNested, { keep: true });
    assert.deepEqual(stored.privateTop, { keep: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory mutation refuses unreadable input and contains write failure", () => {
  let writes = 0;
  const unreadable: AdvisoryConfigIo = {
    readText() {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    writeAtomic() {
      writes += 1;
    },
  };
  const refused = mutateRuntimeConfigAdvisory("config.json", () => {}, { io: unreadable });
  assert.equal(refused.status, "refused-invalid");
  assert.equal(writes, 0);

  const writeFailure: AdvisoryConfigIo = {
    readText: () => "{}",
    writeAtomic() {
      throw new Error("rename denied");
    },
  };
  const failed = mutateRuntimeConfigAdvisory("config.json", () => {}, { io: writeFailure });
  assert.deepEqual(failed, { status: "write-failed", error: "rename denied" });
});
~~~

Add local `productCheck` and `tweakCheck` builders that fill every required field with fixed ISO timestamps and GitHub URLs. Keep them test-only; do not add production builders.

Use these exact values so the mutations type-check against the existing config model:

~~~ts
function productCheck(latestVersion: string): ClaudePlusPlusUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    currentVersion: "0.3.0",
    latestVersion,
    releaseUrl: `https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v${latestVersion}`,
    releaseNotes: null,
    updateAvailable: true,
  };
}

function tweakCheck(id: string, currentVersion: string): TweakUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    repo: `example/${id}`,
    currentVersion,
    latestVersion: "0.2.0",
    latestTag: "v0.2.0",
    releaseUrl: `https://github.com/example/${id}/releases/tag/v0.2.0`,
    updateAvailable: true,
  };
}
~~~

- [ ] **Step 2: Run the focused test and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/config.test.ts
~~~

Expected: FAIL because `mutateRuntimeConfigAdvisory`, `AdvisoryCacheWriteResult`, and `AdvisoryConfigIo` do not exist.

- [ ] **Step 3: Implement the advisory-only read/normalize/commit path**

Refactor the existing normalization body into `normalizeRuntimeConfig(raw)`, then add these exact contracts:

~~~ts
export type AdvisoryCacheWriteResult =
  | { status: "persisted" }
  | { status: "refused-invalid" }
  | { status: "write-failed"; error: string };

export interface AdvisoryConfigIo {
  readText(path: string): string;
  writeAtomic(path: string, config: RuntimeConfig): void;
}

export interface AdvisoryConfigMutationOptions {
  io?: AdvisoryConfigIo;
}

const defaultAdvisoryConfigIo: AdvisoryConfigIo = {
  readText: (path) => readFileSync(path, "utf8"),
  writeAtomic: (path, config) => writeRuntimeConfigAtomic(path, config),
};

export function mutateRuntimeConfigAdvisory(
  path: string,
  mutate: (config: RuntimeConfig) => void,
  options: AdvisoryConfigMutationOptions = {},
): AdvisoryCacheWriteResult {
  const io = options.io ?? defaultAdvisoryConfigIo;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(io.readText(path)) as unknown;
    if (!isRecord(parsed)) return { status: "refused-invalid" };
    raw = parsed;
  } catch (error) {
    if (!isMissingFileError(error)) return { status: "refused-invalid" };
    raw = {};
  }

  const config = normalizeRuntimeConfig(raw);
  mutate(config);
  try {
    io.writeAtomic(path, config);
    return { status: "persisted" };
  } catch (error) {
    return { status: "write-failed", error: errorMessage(error) };
  }
}
~~~

Implement `isMissingFileError` by accepting only an object whose `code === "ENOENT"`. Implement `errorMessage` with the repository's existing `Error`/`String` convention. `readRuntimeConfig` remains permissive and becomes:

~~~ts
export function readRuntimeConfig(path: string): RuntimeConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed)) raw = parsed;
  } catch {}
  return normalizeRuntimeConfig(raw);
}
~~~

Move lines that currently construct `claudePlusPlus`, `tweaks`, and `tweakUpdateChecks` into `normalizeRuntimeConfig` without changing their field order or normalization rules. Do not route `mutateRuntimeConfig` or `setTweakEnabled` through the new advisory function.

- [ ] **Step 4: Run focused config tests and verify GREEN**

~~~powershell
node --import tsx --test packages/runtime/test/config.test.ts
~~~

Expected: PASS, including original default/atomic/explicit-mutation cases and new advisory refusal cases.

- [ ] **Step 5: Commit the isolated config contract**

~~~powershell
git add packages/runtime/src/config.ts packages/runtime/test/config.test.ts
git commit -m "feat: add safe advisory config mutation"
~~~

---

### Task 2: Installed-Tweak Coordinator and Identity-Validated Catalog State

**Files:**
- Modify: `packages/runtime/src/tweak-update.ts`
- Modify: `packages/runtime/test/tweak-update.test.ts`
- Modify: `packages/runtime/src/tweak-catalog.ts:23-46`
- Modify: `packages/runtime/test/tweak-catalog.test.ts`

**Interfaces:**
- Produces: `TweakUpdateChecker.ensure(options) => Promise<TweakUpdateCheck>`.
- Produces: `createTweakUpdateChecker(deps?) => TweakUpdateChecker`; each instance owns one in-flight map.
- Produces: `tweakUpdateIdentity(configFile, manifest) => string` for exact in-process de-duplication.
- Produces: injectable `ReleaseTimer` so the 8,000 ms abort is deterministic.
- Consumes: `mutateRuntimeConfigAdvisory` from Task 1.
- Preserves: `ensureTweakUpdateCheck(options)` as the production default-coordinator convenience export.

- [ ] **Step 1: Write failing cache-boundary, single-flight, and timeout tests**

Use a new checker per test so in-flight state never leaks between cases:

~~~ts
import {
  createTweakUpdateChecker,
  type ReleaseTimer,
  TWEAK_UPDATE_INTERVAL_MS,
} from "../src/tweak-update.ts";

test("same identity shares only the in-flight request", async () => {
  const fixture = updateFixture("{broken");
  const gate = deferred<Response>();
  let requests = 0;
  const checker = createTweakUpdateChecker({
    request: async () => {
      requests += 1;
      return await gate.promise;
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });

  const first = checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  const second = checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  assert.equal(requests, 1);
  assert.strictEqual(first, second);
  gate.resolve(jsonResponse(200, { tag_name: "v0.2.0" }));
  assert.deepEqual(await first, await second);

  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  assert.equal(requests, 2);
  assert.equal(readFileSync(fixture.configFile, "utf8"), "{broken");
  fixture.dispose();
});

test("cache expires exactly at twenty-four hours and identity changes do not join", async () => {
  const fixture = updateFixture("{}\n");
  let requests = 0;
  let current = new Date("2026-08-22T00:00:00.000Z");
  const checker = createTweakUpdateChecker({
    request: async () => {
      requests += 1;
      return jsonResponse(200, { tag_name: "v0.2.0" });
    },
    now: () => current,
  });

  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  current = new Date(current.getTime() + TWEAK_UPDATE_INTERVAL_MS - 1);
  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  assert.equal(requests, 1);

  current = new Date("2026-08-23T00:00:00.000Z");
  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.1") });
  await checker.ensure({
    configFile: fixture.configFile,
    manifest: { ...manifest("0.1.1"), githubRepo: "example/other" },
  });
  assert.equal(requests, 4);
  fixture.dispose();
});

test("the injected eight-second timer aborts without wall-clock waiting", async () => {
  const fixture = updateFixture(null);
  let scheduled: { delay: number; callback: () => void } | null = null;
  const timer: ReleaseTimer = {
    set(callback, delay) {
      scheduled = { callback, delay };
      return { unref() {} };
    },
    clear() {},
  };
  const checker = createTweakUpdateChecker({
    timer,
    request: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by fixture")), { once: true });
    }),
  });
  const pending = checker.ensure({
    configFile: fixture.configFile,
    manifest: manifest("0.1.0"),
  });
  assert.equal(scheduled?.delay, 8_000);
  scheduled?.callback();
  const result = await pending;
  assert.equal(result.updateAvailable, false);
  assert.match(result.error ?? "", /aborted by fixture/);
  fixture.dispose();
});
~~~

Extend the existing `manifest(version)`/`jsonResponse(status, body)` helpers. Add `updateFixture(raw)` that creates a
temporary root, writes `raw` to `config.json` when `raw !== null`, and returns `{ configFile, dispose }`; `dispose`
recursively removes only that temporary root. Use the shared `Deferred<T>` helper above.

Retain the existing newer-release and 404 cases. Add explicit non-OK status and request-rejection assertions. Add a different-identity overlap test with two deferred responses and assert each caller receives its own repository/version result.
Add a service-level table for `"[]\n"` and `"null\n"`: run a real checker with a successful fake GitHub response,
assert it returns the fresh result, and assert the config bytes are unchanged. Add injected persistence cases for both
`{ status: "refused-invalid" }` and `{ status: "write-failed", error: "denied" }`; each check must resolve, call
`onIssue` once, and leave the in-flight map empty so the next sequential call starts a new request.

In `tweak-catalog.test.ts`, seed `config.tweakUpdateChecks` with one matching and one mismatching identity:

~~~ts
test("attaches cached updates only to the matching manifest identity", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-catalog-identity-"));
  try {
    writeTweak(root, "enabled", "com.example.enabled", true);
    writeTweak(root, "broken", "com.example.broken", false);
    const config = configWithDisabled();
    config.tweakUpdateChecks["com.example.enabled"] = cachedTweakCheck({
    repo: "example/tweak",
    currentVersion: "0.2.0",
    latestVersion: "0.3.0",
  });
    config.tweakUpdateChecks["com.example.broken"] = cachedTweakCheck({
      repo: "example/old",
      currentVersion: "0.1.0",
      latestVersion: "9.9.9",
    });
    const listed = listInstalledTweaks({ tweaksRoot: root, config });
    const enabled = listed.find((item) => item.manifest.id === "com.example.enabled");
    const broken = listed.find((item) => item.manifest.id === "com.example.broken");
    assert.equal(enabled?.update?.latestVersion, "0.3.0");
    assert.equal(broken?.update, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
~~~

Add `cachedTweakCheck({ repo, currentVersion, latestVersion })` beside the existing catalog helpers. It returns a
complete `TweakUpdateCheck` with fixed `checkedAt`, sets `latestTag` to `v${latestVersion}`, uses a matching GitHub
`releaseUrl`, and sets `updateAvailable: true`. Import the config type and reuse the existing
`writeTweak`/`configWithDisabled` helpers.

- [ ] **Step 2: Run focused tests and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/tweak-update.test.ts packages/runtime/test/tweak-catalog.test.ts
~~~

Expected: FAIL because the coordinator/timer interfaces are absent, concurrent calls issue duplicates, settled calls are not explicitly cleared, and catalog attachment is id-only.

- [ ] **Step 3: Implement the per-instance coordinator**

Add these contracts near the existing release request type:

~~~ts
export interface ReleaseTimerHandle {
  unref?(): void;
}

export interface ReleaseTimer {
  set(callback: () => void, delay: number): ReleaseTimerHandle;
  clear(handle: ReleaseTimerHandle): void;
}

const defaultReleaseTimer: ReleaseTimer = {
  set: (callback, delay) => setTimeout(callback, delay) as ReleaseTimerHandle,
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TweakUpdateCheckerDeps {
  request?: ReleaseRequest;
  now?: () => Date;
  timer?: ReleaseTimer;
  createAbortController?: () => AbortController;
  persist?: typeof mutateRuntimeConfigAdvisory;
  onIssue?: (message: string) => void;
}

export interface TweakUpdateChecker {
  ensure(options: EnsureTweakUpdateCheckOptions): Promise<TweakUpdateCheck>;
}

export interface EnsureTweakUpdateCheckOptions {
  configFile: string;
  manifest: TweakManifest;
}

export function tweakUpdateIdentity(configFile: string, manifest: TweakManifest): string {
  return [resolve(configFile), manifest.id, manifest.githubRepo, manifest.version].join("\u0000");
}

function isFreshMatchingCheck(
  cached: TweakUpdateCheck | undefined,
  manifest: TweakManifest,
  now: Date,
): cached is TweakUpdateCheck {
  return !!cached &&
    cached.repo === manifest.githubRepo &&
    cached.currentVersion === manifest.version &&
    now.getTime() - Date.parse(cached.checkedAt) < TWEAK_UPDATE_INTERVAL_MS;
}
~~~

Implement `createTweakUpdateChecker` with a closure-owned `Map<string, Promise<TweakUpdateCheck>>`:

~~~ts
export function createTweakUpdateChecker(
  deps: TweakUpdateCheckerDeps = {},
): TweakUpdateChecker {
  const inFlight = new Map<string, Promise<TweakUpdateCheck>>();
  return {
    ensure(options) {
      const now = (deps.now ?? (() => new Date()))();
      const cached = readRuntimeConfig(options.configFile)
        .tweakUpdateChecks[options.manifest.id];
      if (isFreshMatchingCheck(cached, options.manifest, now)) return Promise.resolve(cached);

      const identity = tweakUpdateIdentity(options.configFile, options.manifest);
      const active = inFlight.get(identity);
      if (active) return active;
      const request = checkTweakRelease(
        { manifest: options.manifest },
        deps.request ?? fetch,
        now,
        deps.timer ?? defaultReleaseTimer,
        deps.createAbortController ?? (() => new AbortController()),
      ).then((check) => {
        const result = (deps.persist ?? mutateRuntimeConfigAdvisory)(
          options.configFile,
          (config) => { config.tweakUpdateChecks[options.manifest.id] = check; },
        );
        if (result.status !== "persisted") {
          deps.onIssue?.(`Tweak update cache ${result.status}: ${options.manifest.id}`);
        }
        return check;
      });
      const pending: Promise<TweakUpdateCheck> = request.finally(() => {
        if (inFlight.get(identity) === pending) inFlight.delete(identity);
      });
      inFlight.set(identity, pending);
      return pending;
    },
  };
}
~~~

Create one module-level production checker and keep the existing convenience function:

~~~ts
const productionTweakUpdateChecker = createTweakUpdateChecker();

export function ensureTweakUpdateCheck(
  options: EnsureTweakUpdateCheckOptions,
): Promise<TweakUpdateCheck> {
  return productionTweakUpdateChecker.ensure(options);
}
~~~

Remove the old per-call `request` and `now` fields from `EnsureTweakUpdateCheckOptions`. Migrate tests that need those
dependencies to `createTweakUpdateChecker({ request, now })`; production callers already pass only `configFile` and
`manifest`. Import `resolve` from `node:path` for `tweakUpdateIdentity`.

Thread `ReleaseTimer` and `createAbortController` through `checkTweakRelease`/`fetchLatestRelease`. Schedule exactly `8_000` ms, call `unref?.()`, and clear the returned handle in `finally`. Do not retain resolved checks in the in-flight map.

- [ ] **Step 4: Identity-validate catalog cache attachment**

Replace the id-only assignment in `listInstalledTweaks` with:

~~~ts
const cached = options.config.tweakUpdateChecks[candidate.manifest.id];
const update = cached &&
  cached.repo === candidate.manifest.githubRepo &&
  cached.currentVersion === candidate.manifest.version
  ? cached
  : null;

listed.push({
  ...candidate,
  enabled: !options.config.claudePlusPlus.safeMode &&
    isTweakEnabled(options.config, candidate.manifest.id),
  update,
});
~~~

Do not add eligibility filtering here: missing-entry and incompatible rows remain visible for Claude++ diagnostics.
Task 4's production request path excludes only missing-entry rows.

- [ ] **Step 5: Run focused tests and verify GREEN**

~~~powershell
node --import tsx --test packages/runtime/test/config.test.ts packages/runtime/test/tweak-update.test.ts packages/runtime/test/tweak-catalog.test.ts
~~~

Expected: PASS with one request for overlapping same identity, a second request after refused persistence settles, deterministic abort, and no stale identity attached to diagnostic rows.

- [ ] **Step 6: Commit the coordinator and catalog identity boundary**

~~~powershell
git add packages/runtime/src/tweak-update.ts packages/runtime/src/tweak-catalog.ts packages/runtime/test/tweak-update.test.ts packages/runtime/test/tweak-catalog.test.ts
git commit -m "feat: coordinate Tweak release checks"
~~~

---

### Task 3: Product Release Source, Selection, and Safe Persistence

**Files:**
- Modify: `packages/runtime/src/update-service.ts:47-125,185-201`
- Modify: `packages/runtime/test/update-service.test.ts`

**Interfaces:**
- Extends: `CheckClaudePlusPlusUpdateOptions` with injectable raw request, timer, advisory persistence, and warning sink.
- Preserves: `requestReleases(repo)` injection for selection-focused tests.
- Consumes: `mutateRuntimeConfigAdvisory` from Task 1.
- Preserves: existing 24-hour product cache key, version comparison, Stable/Prerelease official source, Custom saved source, and completion-order persistence.

- [ ] **Step 1: Write failing source-matrix, endpoint, safe-write, and overlap tests**

Add a table-driven repository/selection test. Every row must force or start without a cache:

~~~ts
test("product channels retain Claude++ repository and release-list selection", async () => {
  const cases = [
    {
      channel: "stable",
      savedRepo: "example/custom",
      expectedRepo: "kpkhxlgy0/claude-plusplus",
      expectedVersion: "0.3.1",
    },
    {
      channel: "prerelease",
      savedRepo: "example/custom",
      expectedRepo: "kpkhxlgy0/claude-plusplus",
      expectedVersion: "0.4.0-beta.1",
    },
    {
      channel: "custom",
      savedRepo: "example/custom",
      expectedRepo: "example/custom",
      expectedVersion: "0.3.1",
    },
  ] as const;

  for (const item of cases) {
    const fixture = updateServiceFixture({
      updateChannel: item.channel,
      updateRepo: item.savedRepo,
    });
    let requestedRepo = "";
    const result = await checkClaudePlusPlusUpdate({
      ...fixture.paths,
      force: true,
      requestReleases: async (repo) => {
        requestedRepo = repo;
        return [
          release("v0.4.0-beta.1", true),
          release("v0.3.1", false),
        ];
      },
    });
    assert.equal(requestedRepo, item.expectedRepo);
    assert.equal(result.latestVersion, item.expectedVersion);
    fixture.dispose();
  }
});

test("the default product request uses the release-list endpoint", async () => {
  const fixture = updateServiceFixture({ updateChannel: "stable" });
  let requestedUrl = "";
  const delays: number[] = [];
  await checkClaudePlusPlusUpdate({
    ...fixture.paths,
    force: true,
    request: async (input) => {
      requestedUrl = String(input);
      return jsonResponse(200, [release("v0.3.1", false)]);
    },
    timer: recordingTestTimer(delays),
  });
  assert.equal(
    requestedUrl,
    "https://api.github.com/repos/kpkhxlgy0/claude-plusplus/releases?per_page=20",
  );
  assert.deepEqual(delays, [8_000]);
  fixture.dispose();
});

test("automatic and forced product checks return results without replacing invalid config", async () => {
  for (const raw of ["{broken", "[]\n", "null\n"]) {
    for (const force of [false, true]) {
      const fixture = updateServiceFixtureRaw(raw);
      const result = await checkClaudePlusPlusUpdate({
        ...fixture.paths,
        force,
        requestReleases: async () => [release("v0.3.1", false)],
      });
      assert.equal(result.updateAvailable, true);
      assert.equal(readFileSync(fixture.paths.configFile, "utf8"), raw);
      fixture.dispose();
    }
  }
});
~~~

Extend the existing update-service fixture instead of introducing production helpers:

- `updateServiceFixture(overrides?)` returns the current `{ paths, dispose }` and writes the requested channel/repo.
- `updateServiceFixtureRaw(raw)` creates the same three path fields, writes `raw` verbatim to `configFile`, and removes
  only its temporary root in `dispose`.
- `release(tag, prerelease)` returns a complete `GitHubReleaseView` with deterministic `html_url`, `body`, and
  `draft: false`.
- `jsonResponse(status, body)` returns `new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json" } })`.
- `recordingTestTimer(delays)` returns a timer whose `set` pushes the delay and returns `{}`; `clear`
  is a no-op. The endpoint test asserts `8_000` was scheduled without firing the callback.

Add an overlap test with two deferred `requestReleases` calls. Resolve the forced call first and the earlier automatic call last; assert the final `claudePlusPlus.updateCheck` is the automatic call's result. This records the approved last-completion rule rather than adding request priority.

Add a persistence-injection case returning `{ status: "write-failed", error: "denied" }`; assert the check still resolves and `onIssue` receives one warning. Retain current equal-core prerelease and explicit self-update command tests.

- [ ] **Step 2: Run the focused product test and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/update-service.test.ts
~~~

Expected: FAIL because raw `request`/`timer`/`persist`/`onIssue` dependencies are absent and the service still calls ordinary `mutateRuntimeConfig`.

- [ ] **Step 3: Add deterministic product-request dependencies without changing channel rules**

Extend `CheckClaudePlusPlusUpdateOptions`:

~~~ts
export interface ProductUpdateTimer {
  set(callback: () => void, delay: number): ProductUpdateTimerHandle;
  clear(handle: ProductUpdateTimerHandle): void;
}

export type ProductUpdateTimerHandle = object;

const defaultProductUpdateTimer: ProductUpdateTimer = {
  set: (callback, delay) => setTimeout(callback, delay) as ProductUpdateTimerHandle,
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CheckClaudePlusPlusUpdateOptions extends UpdateServicePaths {
  force?: boolean;
  now?: () => Date;
  requestReleases?: (repo: string) => Promise<GitHubReleaseView[]>;
  request?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timer?: ProductUpdateTimer;
  persist?: typeof mutateRuntimeConfigAdvisory;
  onIssue?: (message: string) => void;
}
~~~

Add this test-only timer helper beside the update-service fixture:

~~~ts
function recordingTestTimer(delays: number[]): ProductUpdateTimer {
  return {
    set(_callback, delay) {
      delays.push(delay);
      return {};
    },
    clear() {},
  };
}
~~~

Change the default `requestReleases` helper to accept the injected raw request and timer:

~~~ts
async function requestReleases(
  repo: string,
  request = fetch,
  timer: ProductUpdateTimer = defaultProductUpdateTimer,
): Promise<GitHubReleaseView[]> {
  const controller = new AbortController();
  const timeout = timer.set(() => controller.abort(), 8_000);
  try {
    const response = await request(
      `https://api.github.com/repos/${repo}/releases?per_page=20`,
      {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": `claude-plusplus/${CLAUDE_PLUSPLUS_VERSION}`,
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json() as GitHubReleaseView[];
  } finally {
    timer.clear(timeout);
  }
}
~~~

Choose the request function without changing selection:

~~~ts
const loadReleases = options.requestReleases ??
  ((repo: string) => requestReleases(
    repo,
    options.request ?? fetch,
    options.timer ?? defaultProductUpdateTimer,
  ));
const releases = await loadReleases(repo);
const release = releases.find((candidate) =>
  !candidate.draft && (includePrerelease || !candidate.prerelease));
~~~

- [ ] **Step 4: Route product cache commits through the advisory writer**

Replace the ordinary mutation after the request with:

~~~ts
const persistence = (options.persist ?? mutateRuntimeConfigAdvisory)(
  options.configFile,
  (config) => { config.claudePlusPlus.updateCheck = check; },
);
if (persistence.status !== "persisted") {
  options.onIssue?.(`Claude++ update cache ${persistence.status}`);
}
return check;
~~~

Do not add channel/repository fields to the persistent cache key and do not clear the cache on channel changes; both are explicit non-goals in the approved spec.

- [ ] **Step 5: Run focused product/config tests and verify GREEN**

~~~powershell
node --import tsx --test packages/runtime/test/config.test.ts packages/runtime/test/update-service.test.ts
~~~

Expected: PASS with official Stable/Prerelease source, saved Custom source, list endpoint, local release selection, malformed-byte preservation, and completion-order persistence.

- [ ] **Step 6: Commit the product service boundary**

~~~powershell
git add packages/runtime/src/update-service.ts packages/runtime/test/update-service.test.ts
git commit -m "feat: harden Claude++ release checks"
~~~

---

### Task 4: Awaited Production Tweak Catalog Checks and Concurrent Commit Integration

**Files:**
- Modify: `packages/runtime/src/management-ipc.ts:27-57,149-152`
- Modify: `packages/runtime/src/main.ts:33-52,73-81,139-147`
- Modify: `packages/runtime/test/management-ipc.test.ts`
- Modify: `packages/runtime/test/main.test.ts`
- Create: `packages/runtime/test/advisory-update-concurrency.test.ts`

**Interfaces:**
- Extends: `ManagementIpcDeps.tweakUpdateChecker?: TweakUpdateChecker`.
- Extends: `RuntimeBootstrapDeps` and `RuntimeModuleInitializerDeps` with the same optional checker for deterministic bootstrap tests.
- Consumes: `createTweakUpdateChecker`, `tweakUpdateIdentity`, and `TweakUpdateChecker` from Task 2.
- Produces: async `claudepp:list-tweaks` handler that returns its snapshot with current-batch results attached.

- [ ] **Step 1: Write failing management IPC orchestration tests**

Extract the existing fake-handler setup into a local fixture that can create Tweak directories with configurable `enabled`, entry presence, and `minRuntime`. Add three ordinary Tweaks, one runtime-incompatible entry-present Tweak, and deferred checker results:

~~~ts
test("list-tweaks starts every entry-present check before awaiting and returns fresh results", async () => {
  const fixture = managementFixture([
    tweak("com.example.one"),
    tweak("com.example.two", { enabled: false }),
    tweak("com.example.three"),
    tweak("com.example.missing", { entryExists: false }),
    tweak("com.example.future", { minRuntime: "99.0.0" }),
  ]);
  const pending = new Map<string, Deferred<TweakUpdateCheck>>();
  const started: string[] = [];
  fixture.install({
    ensure({ manifest }) {
      started.push(manifest.id);
      const gate = deferred<TweakUpdateCheck>();
      pending.set(manifest.id, gate);
      return gate.promise;
    },
  });

  const response = fixture.invoke("claudepp:list-tweaks");
  assert.deepEqual(started.sort(), [
    "com.example.future",
    "com.example.one",
    "com.example.three",
    "com.example.two",
  ]);
  assert.equal(await isSettled(response), false);

  for (const [id, gate] of pending) gate.resolve(updateFor(id));
  const listed = await response;
  assert.equal(find(listed, "com.example.one").update?.latestVersion, "0.3.1");
  assert.equal(find(listed, "com.example.two").update?.latestVersion, "0.3.1");
  assert.equal(find(listed, "com.example.missing").update, null);
  assert.equal(find(listed, "com.example.future").update?.latestVersion, "0.3.1");
  fixture.dispose();
});
~~~

Build `managementFixture(specs)` by extending the current management IPC fake-app fixture. It must create a temporary
Tweaks root, write each manifest and optional entry file, write enabled state to its temporary config, capture the
registered handlers, and return `{ install(checker), invoke(channel), dispose }`. `invoke` always wraps the handler
result with `Promise.resolve`. `tweak(...)`, `updateFor(id)`, and `find(list, id)` must fill the existing manifest/view
types; `isSettled(promise)` races the promise against one `setImmediate` sentinel and never changes the promise.

Add these exact cases:

- two concurrent `claudepp:list-tweaks` calls with one injected real checker share its same-identity request;
- a fake checker result is attached even when its persistence function returns `refused-invalid`;
- a runtime-incompatible entry-present row starts a request and receives its current-batch result;
- a missing-entry row exposes only a pre-seeded repo/version-matching cache and never starts a request;
- checker rejection is converted by the real checker into an advisory result, so the handler itself still resolves.

In `main.test.ts`, inject a fake checker through `RuntimeModuleInitializerDeps` and capture the object passed to the bootstrap override. Assert object identity is preserved into `RuntimeBootstrapDeps`.

- [ ] **Step 2: Run the focused IPC/bootstrap tests and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/management-ipc.test.ts packages/runtime/test/main.test.ts
~~~

Expected: FAIL because `claudepp:list-tweaks` is synchronous, no checker dependency is accepted, and bootstrap does not forward one.

- [ ] **Step 3: Implement one snapshot, parallel checks, and direct result attachment**

Add the optional checker to `ManagementIpcDeps` and construct the production default once per installed IPC surface:

~~~ts
const tweakUpdateChecker = deps.tweakUpdateChecker ?? createTweakUpdateChecker({
  onIssue: (message) => deps.log.warn(message),
});
~~~

Replace the list handler with:

~~~ts
register("claudepp:list-tweaks", async () => {
  const snapshot = listTweaks();
  const fresh = new Map<string, TweakUpdateCheck>();
  await Promise.all(snapshot
    .filter((item) => item.entryExists)
    .map(async (item) => {
      const check = await tweakUpdateChecker.ensure({
        configFile: deps.configFile,
        manifest: item.manifest,
      });
      fresh.set(tweakUpdateIdentity(deps.configFile, item.manifest), check);
    }));

  return snapshot.map((item) => {
    const update = fresh.get(tweakUpdateIdentity(deps.configFile, item.manifest));
    return update ? { ...item, update } : item;
  });
});
~~~

Do not filter on `enabled` or `compatible`. Do not relist after the requests: the response must represent the original discovery snapshot plus its corresponding current-batch advisory results.

Add optional `tweakUpdateChecker` fields to both Runtime dependency interfaces, forward it through `initializeRuntimeModule`, and pass it to `installManagementIpc` in `bootstrapRuntime`. Production callers omit it and get the real coordinator.

When registering `claudepp:check-claudepp-update`, pass `onIssue: (message) => deps.log.warn(message)` so product cache refusal/write failure is logged without rejecting Settings.

- [ ] **Step 4: Write distinct-slot merge characterization and shared-slot tests**

In the new `advisory-update-concurrency.test.ts`, use a real temp config, one real checker, and four deferred requests:

~~~ts
test("parallel product and distinct-id Tweak completions preserve every slot and intervening config", async () => {
  const fixture = concurrencyFixture();
  const tweakGates = new Map<string, Deferred<Response>>();
  const checker = createTweakUpdateChecker({
    request: async (input) => {
      const id = repoFromUrl(String(input));
      const gate = deferred<Response>();
      tweakGates.set(id, gate);
      return await gate.promise;
    },
  });
  const productGate = deferred<GitHubReleaseView[]>();

  const checks = [
    checker.ensure({ configFile: fixture.configFile, manifest: manifestFor("one") }),
    checker.ensure({ configFile: fixture.configFile, manifest: manifestFor("two") }),
    checker.ensure({ configFile: fixture.configFile, manifest: manifestFor("three") }),
    checkClaudePlusPlusUpdate({
      ...fixture.updatePaths,
      force: true,
      requestReleases: async () => await productGate.promise,
    }),
  ];
  mutateRuntimeConfig(fixture.configFile, (config) => {
    config.privateState = { changedWhilePending: true };
  });

  tweakGates.get("one")?.resolve(latestResponse("0.2.0"));
  productGate.resolve([release("v0.3.1", false)]);
  tweakGates.get("three")?.resolve(latestResponse("0.2.0"));
  tweakGates.get("two")?.resolve(latestResponse("0.2.0"));
  await Promise.all(checks);

  const stored = readRuntimeConfig(fixture.configFile);
  assert.deepEqual(stored.privateState, { changedWhilePending: true });
  assert.equal(stored.claudePlusPlus.updateCheck?.latestVersion, "0.3.1");
  assert.deepEqual(Object.keys(stored.tweakUpdateChecks).sort(), [
    "com.example.one",
    "com.example.three",
    "com.example.two",
  ]);
  fixture.dispose();
});
~~~

`concurrencyFixture()` creates and owns one temporary source root, config file, and self-update-state path, writes a
valid object config, and returns `{ configFile, updatePaths, dispose }`. `repoFromUrl` extracts the repository suffix
from `/repos/<owner>/<repo>/releases/latest`; `latestResponse`, `manifestFor`, and `release` produce complete existing
types with fixed URLs and timestamps. Assert every deferred gate exists before resolving it rather than relying on
optional chaining in the final test.

Add a second test for one manifest id with old/new repo or version. Resolve the new identity first and the old identity
last; assert each promise returns its own check while the single persisted id slot contains the old request that
completed last. Invoke the new identity once more and assert the mismatched old slot is rejected and a third request
starts. This is the deliberately retained one-slot behavior.

- [ ] **Step 5: Run the characterization and complete Task 4 verification**

Run after Tasks 1–3 and before changing management orchestration:

~~~powershell
node --import tsx --test packages/runtime/test/advisory-update-concurrency.test.ts
~~~

Expected: the distinct-slot case is a GREEN characterization of the existing commit-time re-read behavior once both
services use Task 1's advisory writer. The same-id/different-identity case also passes and records the deliberately
retained one-slot last-completion behavior. Task 4's RED evidence comes from Steps 1–2, not from manufacturing a lost
update that the current mutation helper does not have.

Run after Tasks 1–4 code is connected:

~~~powershell
node --import tsx --test packages/runtime/test/config.test.ts packages/runtime/test/tweak-update.test.ts packages/runtime/test/tweak-catalog.test.ts packages/runtime/test/update-service.test.ts packages/runtime/test/management-ipc.test.ts packages/runtime/test/main.test.ts packages/runtime/test/advisory-update-concurrency.test.ts
~~~

Expected GREEN: every distinct slot survives, same-id/different-identity retains last completion, disabled and
runtime-incompatible entry-present Tweaks are checked, and missing-entry Tweaks are not.

- [ ] **Step 6: Commit production catalog orchestration**

~~~powershell
git add packages/runtime/src/management-ipc.ts packages/runtime/src/main.ts packages/runtime/test/management-ipc.test.ts packages/runtime/test/main.test.ts packages/runtime/test/advisory-update-concurrency.test.ts
git commit -m "feat: refresh Tweak updates in catalog"
~~~

---

### Task 5: Settings Navigation/Visibility Signals and Generic Group-Header Actions

**Files:**
- Modify: `packages/runtime/src/preload/claude-settings-shell-adapter.ts`
- Modify: `packages/runtime/src/preload/settings-injector.ts`
- Modify: `packages/runtime/test/fixtures/settings-dom.ts`
- Modify: `packages/runtime/test/claude-settings-shell-adapter.test.ts`
- Modify: `packages/runtime/test/preload-sandbox.test.mjs`

**Interfaces:**
- Produces: `SettingsNavigationHeaderAction { id, label, title, onClick }`.
- Extends: `SettingsNavigationGroup.headerAction?`.
- Extends: `SettingsShellAdapter.setNavigationMountListener((visible) => ...)`.
- Extends: `SettingsShellAdapter.setVisibilityListener(listener)`.
- Extends: `SettingsShellEnvironment` with computed-style, geometry, ResizeObserver, and window-resize dependencies.
- Produces: navigation mount/remount and visual visibility as separate signals; no product or Store service is called in this task.

- [ ] **Step 1: Extend the fake Settings DOM and write failing visibility tests**

Make the fixture drive the same public signals production uses. Add an `isConnected` getter, mutable computed style/rect state for the current dialog, and observer fakes:

~~~ts
class MiniResizeObserver {
  public static instances: MiniResizeObserver[] = [];
  private observing = false;
  public constructor(callback: () => void) {
    this.callback = callback;
    MiniResizeObserver.instances.push(this);
  }
  private readonly callback: () => void;
  public observe() { this.observing = true; }
  public disconnect() { this.observing = false; }
  public static flush(): void {
    for (const instance of MiniResizeObserver.instances) {
      if (instance.observing) instance.callback();
    }
  }
}

const windowListeners = new Map<string, Set<() => void>>();
const windowEvents = {
  addEventListener(type: string, listener: () => void) {
    const listeners = windowListeners.get(type) ?? new Set();
    listeners.add(listener);
    windowListeners.set(type, listeners);
  },
  removeEventListener(type: string, listener: () => void) {
    windowListeners.get(type)?.delete(listener);
  },
};
~~~

Expose fixture methods `setDialogStyle({ display, visibility })`, `setDialogRect(width, height)`, `flushAttributeMutation()`, `flushResize()`, `flushWindowResize()`, `removeSettingsShell()`, and `replaceVisibleSettingsShell()`. `flushAttributeMutation` must call the registered MutationObserver callback; tests must not call adapter-private synchronization functions.
Reset `MiniResizeObserver.instances` and `windowListeners` when each fixture is created. Add a stop assertion showing
that the active resize observer is disconnected, the window listener is removed, and later public signal flushes emit
no state.

Add these adapter tests:

~~~ts
test("reports only connected displayed visible positive-area transitions", () => {
  const fixture = settingsFixture({ display: "none", width: 800, height: 600 });
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const states: boolean[] = [];
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));
  assert.deepEqual(states, [false]);

  fixture.setDialogStyle({ display: "block", visibility: "hidden" });
  fixture.flushAttributeMutation();
  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.setDialogRect(0, 600);
  fixture.flushResize();
  assert.deepEqual(states, [false]);

  fixture.setDialogRect(800, 600);
  fixture.flushResize();
  fixture.flushWindowResize();
  fixture.flushMutation();
  assert.deepEqual(states, [false, true]);

  fixture.removeSettingsShell();
  fixture.flushMutation();
  assert.deepEqual(states, [false, true, false]);
  adapter.stop();
});

test("a direct visible shell replacement does not invent another visible transition", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const states: boolean[] = [];
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));
  fixture.replaceVisibleSettingsShell();
  fixture.flushMutation();
  assert.deepEqual(states, [true]);
  adapter.stop();
});
~~~

Add separate assertions showing each attribute, ResizeObserver, and window resize fake triggers predicate re-evaluation. Verify `MutationObserver.observe` receives `childList: true`, `subtree: true`, `attributes: true`, and exactly the approved attribute filter.

Add a separate hidden-dialog test for `setNavigationMountListener((visible) => mounts.push(visible))`. Install the
listener before `start()`, then call `setNavigation(...)`; assert it emits `[false]` only after the group DOM is attached.
A controller-driven `setNavigation` update and an ordinary same-shell MutationObserver flush while the owned group
remains attached must not emit again, matching Codex++'s early-return branch and preventing a product result from
recursively triggering itself. Externally detach the owned group and flush the observer; assert the recreated hidden
group adds `false`. Replace the shell directly with a visible shell and assert its newly attached navigation adds `true`,
while the visibility test above still emits no artificial false→true transition. Add a fixture helper that removes only
the injected Claude++ group, never the native navigation.

Enhance the fixture with observed-attribute write counters or an equivalent queued-mutation fake. Add a test that takes
an already attached group through one same-shell attribute observer turn, drains queued observer work with a small hard
limit, and proves it does not self-reschedule. This must model the observed `class` attribute, not merely call the
callback once by hand.

- [ ] **Step 2: Write the failing generic header-action test**

~~~ts
test("renders one generic group-header action and uses its current callback", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const calls: string[] = [];
  adapter.start();
  adapter.setNavigation([{
    id: "claudepp",
    title: "CLAUDE++",
    headerAction: {
      id: "update",
      label: "Update",
      title: "Review Claude++ v0.3.1",
      onClick: () => { calls.push("first"); },
    },
    items: [{ id: "config", title: "Config" }],
  }], () => {});

  const button = fixture.groupAction("update");
  assert.equal(button?.textContent, "Update");
  assert.equal(button?.title, "Review Claude++ v0.3.1");

  adapter.setNavigation([{
    id: "claudepp",
    title: "CLAUDE++",
    headerAction: {
      id: "update",
      label: "Update",
      title: "Review Claude++ v0.3.1",
      onClick: () => { calls.push("current"); },
    },
    items: [{ id: "config", title: "Config" }],
  }], () => {});
  fixture.click(button);
  assert.deepEqual(calls, ["current"]);
  assert.equal(fixture.countGroupActions("update"), 1);
  adapter.stop();
});
~~~

- [ ] **Step 3: Run the focused adapter test and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/claude-settings-shell-adapter.test.ts
~~~

Expected: FAIL because the fixture has no lifecycle signals, the adapter has no navigation/visibility listeners or predicate, and groups have no header action.

- [ ] **Step 4: Implement the shell environment and action contracts**

Use these exact public-internal shapes:

~~~ts
export interface SettingsShellEnvironment {
  document: Document;
  MutationObserver: typeof MutationObserver;
  ResizeObserver: typeof ResizeObserver;
  getComputedStyle(element: Element): Pick<CSSStyleDeclaration, "display" | "visibility">;
  getBoundingClientRect(element: Element): Pick<DOMRect, "width" | "height">;
  windowEvents: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface SettingsNavigationHeaderAction {
  id: string;
  label: string;
  title: string;
  onClick(): void | Promise<void>;
}

export interface SettingsNavigationGroup {
  id: string;
  title: string;
  items: SettingsNavigationItem[];
  headerAction?: SettingsNavigationHeaderAction;
}
~~~

Add `setNavigationMountListener(listener: (visible: boolean) => void): void` and
`setVisibilityListener(listener: (visible: boolean) => void): void` to `SettingsShellAdapter`. The navigation listener
is called after current groups are first attached to a shell or recreated after the owned group was detached; do not
gate the event itself on visual visibility; pass the current strict visual predicate as its boolean argument so the
injector can defer a hidden mount. When the same shell still contains the adapter's current group elements,
`syncShell()` keeps Codex++'s early return and does not notify for ordinary observer noise, visibility changes, or a
controller-driven `setNavigation` refresh. This prevents recursive product checks. Store `lastVisible` and immediately
publish the current state when a visibility listener is installed, but suppress repeated equal values.

In `start()`, extend the existing observer:

~~~ts
observer.observe(environment.document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
});
environment.windowEvents.addEventListener("resize", onWindowResize);
~~~

Maintain one `ResizeObserver` for the current dialog. Disconnect/rebind when the dialog changes and disconnect/remove the window listener in `stop()`.

Define the predicate exactly:

~~~ts
function isShellVisible(candidate: SettingsShell | null): boolean {
  if (!candidate?.dialog.isConnected) return false;
  const style = environment.getComputedStyle(candidate.dialog);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = environment.getBoundingClientRect(candidate.dialog);
  return rect.width > 0 && rect.height > 0;
}
~~~

When `syncShell()` replaces one visible dialog directly with another, bind the new observer and publish only the final predicate. Do not emit an intermediate false merely because the dialog identity changed.

Make same-shell synchronization DOM-read-only when navigation identity and active state are unchanged. In particular,
compute the next active button class string and assign `button.className` only when it differs; the observer watches
`class`, so an unconditional same-value write can create a Chromium MutationObserver feedback loop. Repeated
`aria-current` writes are outside the approved attribute filter, but may also be equality-guarded. The queued-mutation
test from Step 1 must fail without this guard and terminate after one external signal with it.

- [ ] **Step 5: Render group labels and actions without stale closures**

Render the heading as a flex container with a dedicated label span plus optional action button:

~~~ts
const label = environment.document.createElement("span");
label.setAttribute("data-claudepp-settings-group-label", group.id);
label.textContent = group.title;
heading.appendChild(label);
if (group.headerAction) heading.appendChild(createHeaderAction(group.id, group.headerAction));
~~~

Include action id/label/title, but not a callback or URL, in `navigationKey`. The click listener must look up the current `groups` entry by group/action id before invoking `onClick`:

~~~ts
const current = groups.find((candidate) => candidate.id === groupId)?.headerAction;
if (current?.id === actionId) void current.onClick();
~~~

Set `data-claudepp-settings-group-action`, button `title`, `aria-label`, and blue pill styling. Keep item-badge markup and
active navigation behavior unchanged. Do not add a local click rejection handler. Do not execute an intentionally
rejecting action in the Node test runner; Task 9 verifies this exact source shape against Codex++.

- [ ] **Step 6: Supply production observer dependencies and update sandbox coverage**

In `startSettingsInjector`'s default environment, pass:

~~~ts
{
  document,
  MutationObserver,
  ResizeObserver,
  getComputedStyle: (element) => getComputedStyle(element),
  getBoundingClientRect: (element) => element.getBoundingClientRect(),
  windowEvents: window,
}
~~~

Extend `preload-sandbox.test.mjs` with a no-op `ResizeObserver`, `getComputedStyle`, positive `getBoundingClientRect`, `documentElement.contains`/`isConnected` support required by the bundle fixture, and window `removeEventListener`. The sandbox test must still assert one Settings MutationObserver and no unexpected IPC.

- [ ] **Step 7: Run adapter and preload bundle tests and verify GREEN**

~~~powershell
node --import tsx --test packages/runtime/test/claude-settings-shell-adapter.test.ts
npm run build --workspace @claude-plusplus/runtime
node --test packages/runtime/test/preload-sandbox.test.mjs
~~~

Expected: PASS with navigation mount/remount callbacks and attached-group suppression, observer-driven visibility, direct visible replacement suppression, one current header action, and a sandbox-safe built preload.

- [ ] **Step 8: Commit the generic Settings shell contract**

~~~powershell
git add packages/runtime/src/preload/claude-settings-shell-adapter.ts packages/runtime/src/preload/settings-injector.ts packages/runtime/test/fixtures/settings-dom.ts packages/runtime/test/claude-settings-shell-adapter.test.ts packages/runtime/test/preload-sandbox.test.mjs
git commit -m "feat: observe Settings shell lifecycle"
~~~

---

### Task 6: Controller-Owned Claude++ Update Indicator and Manual Publication

**Files:**
- Modify: `packages/runtime/src/settings/types.ts`
- Modify: `packages/runtime/src/settings/product-controller.ts`
- Modify: `packages/runtime/src/settings/config-page.ts:18-35,152-173`
- Modify: `packages/runtime/src/preload/settings-injector.ts`
- Modify: `packages/runtime/test/settings-product-controller.test.ts`
- Modify: `packages/runtime/test/settings-config-page.test.ts`
- Modify: `packages/runtime/test/settings-injector.test.ts`

**Interfaces:**
- Extends: `SettingsProductServices.openExternal(url)`.
- Extends: `SettingsProductPageContext.setProductUpdateCheck(check)`.
- Produces: `SettingsProductController.setProductUpdateCheck(check)`.
- Extends: `ConfigPageContext.publishProductUpdate(check)`.
- Consumes: Task 5 navigation-mount/visibility listeners, header action, and Task 3 product IPC result.

- [ ] **Step 1: Write failing controller action/state tests**

Add a product update builder and make fake services record external opens:

~~~ts
test("publishes one product Update action and removes it for current or failed results", async () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const opened: string[] = [];
  const controller = new SettingsProductController(adapter, {
    ...fakeServices(),
    async openExternal(url) { opened.push(url); },
  });
  controller.start();

  controller.setProductUpdateCheck(productCheck({
    latestVersion: "0.3.1",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
    updateAvailable: true,
  }));
  const action = adapter.navigation[0]?.headerAction;
  assert.equal(action?.label, "Update");
  assert.match(action?.title ?? "", /0\.3\.1/);
  await action?.onClick();
  assert.deepEqual(opened, [
    "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
  ]);

  controller.setProductUpdateCheck(productCheck({ releaseUrl: null }));
  const fallbackAction = adapter.navigation[0]?.headerAction;
  assert.equal(fallbackAction?.label, "Update");
  await fallbackAction?.onClick();
  assert.equal(
    opened.at(-1),
    "https://github.com/kpkhxlgy0/claude-plusplus/releases",
  );

  controller.setProductUpdateCheck(productCheck({
    latestVersion: "0.3.0",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.0",
    updateAvailable: false,
  }));
  assert.equal(adapter.navigation[0]?.headerAction, undefined);
  controller.setProductUpdateCheck(null);
  assert.equal(adapter.navigation[0]?.headerAction, undefined);
});

test("an existing action dereferences the controller's current release URL", async () => {
  const fixture = settingsFixture();
  const opened: string[] = [];
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, {
    ...fakeServices(),
    async openExternal(url) { opened.push(url); },
  });
  controller.start();
  controller.setProductUpdateCheck(availableProductCheck("https://github.com/example/first"));
  const retainedAction = adapter.navigation[0]?.headerAction;
  controller.setProductUpdateCheck(availableProductCheck("https://github.com/example/current"));
  await retainedAction?.onClick();
  assert.deepEqual(opened, ["https://github.com/example/current"]);
});
~~~

Also assert Store badge and product header action coexist after either setter runs. Current/error/null results remove the
action; `updateAvailable: true` with a missing URL retains it and uses the official fallback.
Add `openExternal: async () => {}` to the existing `fakeServices()`, and add the Task 5
`setNavigationMountListener(_listener) {}` and `setVisibilityListener(_listener) {}` methods to
`FakeSettingsShellAdapter`.

Use one complete builder in all three Settings test files:

~~~ts
function productCheck(
  overrides: Partial<ClaudePlusPlusUpdateCheck> = {},
): ClaudePlusPlusUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    currentVersion: "0.3.0",
    latestVersion: "0.3.1",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
    releaseNotes: null,
    updateAvailable: true,
    ...overrides,
  };
}

function availableProductCheck(
  releaseUrl = "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
): ClaudePlusPlusUpdateCheck {
  return productCheck({ releaseUrl });
}
~~~

- [ ] **Step 2: Write failing Config-page publication test**

Extend the Config context fake so `claudepp:check-claudepp-update` returns an available check:

~~~ts
test("Check Now publishes the forced product result before rerendering Config", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const published: ClaudePlusPlusUpdateCheck[] = [];
  const page = context(root, config(), absentWatcher(), {
    check: availableProductCheck(),
    publish(check) { if (check) published.push(check); },
  });
  await renderConfigPage(page);
  fixture.click(findButtonByText(root, "Check Now"));
  await flushPromises();
  assert.equal(published.at(-1)?.latestVersion, "0.3.1");
});
~~~

Keep the Watcher section's unrelated `Check Now` distinguishable by locating the button within the Claude++ Updates section.
Extend the existing `context` helper with an optional
`{ check?: ClaudePlusPlusUpdateCheck; publish?(check: ClaudePlusPlusUpdateCheck | null): void }` fourth argument. Its returned
`invoke<T = unknown>(channel): Promise<T>` casts the known fixture values only at the generic boundary, and its
`publishProductUpdate` calls `options.publish ?? (() => {})`. Implement
`findButtonByText(root, label)` with `Array.from(root.querySelectorAll("button"))`, exact trimmed text equality, and an
`assert.ok` before returning the button. Implement `flushPromises()` as one
`new Promise<void>((resolve) => setImmediate(resolve))`.

- [ ] **Step 3: Write failing automatic navigation-mount/generation tests**

In `settings-injector.test.ts`, use a hidden fixture and a management bridge that records calls:

~~~ts
test("a hidden navigation mount defers product metadata until first visibility", async () => {
  const fixture = settingsFixture({ display: "none" });
  const product = deferred<ClaudePlusPlusUpdateCheck>();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") return await product.promise;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);
  assert.ok(fixture.findPageButton("claudepp:config"));
  assert.deepEqual(calls, []);

  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushAttributeMutation();
  assert.deepEqual(calls, ["claudepp:check-claudepp-update"]);
  assert.ok(fixture.findPageButton("claudepp:config"));
  product.resolve(availableProductCheck());
  await flushPromises();
  assert.equal(fixture.countGroupActions("claudepp-update"), 1);
});
~~~

Add:

- a direct visible-shell replacement invokes the product service again even though visibility remains continuously true;
- ordinary same-shell observer/visibility signals do not invoke the product service again while the owned navigation
  group remains attached;
- externally detaching and recreating the owned group invokes the product service again only when that recreated mount
  is visible; the Main 24-hour cache, not Renderer suppression, owns network reuse;
- product IPC rejection removes/hides the action and does not remove navigation;
- an automatic request from document A that resolves after document B replaces the environment cannot add an action to either B's controller or A's detached DOM;
- a forced Config `Check Now` from document A that resolves after a hidden document B replaces the environment cannot
  update B's controller or rerender A's detached Config root; retain the old root reference and assert its text and
  management-call count do not change after settlement;
- automatic then forced, and forced then automatic, publish in completion order with no request-generation priority.

Add one production-wiring action test. Start with a visible fixture, have the bridge return
`availableProductCheck()` for `claudepp:check-claudepp-update`, await the header action, snapshot the call count, click
`fixture.groupAction("claudepp-update")`, and await one `setImmediate`. Assert the only new bridge call is:

~~~ts
[
  "claudepp:open-external",
  "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
]
~~~

Assert none of `claudepp:run-claudepp-update`, `claudepp:install-store-tweak`, Watcher, spawn, or archive channels
were called. Repeat with an available result whose `releaseUrl` is `null` and assert the only click call opens
`https://github.com/kpkhxlgy0/claude-plusplus/releases`. Restore the rejecting test bridge after the case so other
visible-fixture tests remain isolated.

- [ ] **Step 4: Run focused Settings tests and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-config-page.test.ts packages/runtime/test/settings-injector.test.ts
~~~

Expected: FAIL because product state, header action generation, navigation-mount orchestration, generation guards, fallback URL behavior, and manual publication do not exist.

- [ ] **Step 5: Add product state and current-state action generation**

In `settings/types.ts`:

~~~ts
export interface SettingsProductPageContext {
  root: HTMLElement;
  listedTweaks: readonly ListedTweakView[];
  sections: readonly RegisteredSettingsSection[];
  pages: readonly RegisteredSettingsPage[];
  activate(id: string): void;
  setStoreUpdateCount(count: number): void;
  setProductUpdateCheck(check: ClaudePlusPlusUpdateCheck | null): void;
}

export interface SettingsProductServices {
  renderConfig: SettingsProductPageRenderer;
  renderTweaks: SettingsProductPageRenderer;
  renderStore: SettingsProductPageRenderer;
  openExternal(url: string): Promise<unknown>;
}
~~~

In `SettingsProductController` add `private productUpdateCheck: ClaudePlusPlusUpdateCheck | null = null` and:

~~~ts
const CLAUDE_PLUSPLUS_RELEASES_URL =
  "https://github.com/kpkhxlgy0/claude-plusplus/releases";

public setProductUpdateCheck(check: ClaudePlusPlusUpdateCheck | null): void {
  this.productUpdateCheck = check;
  this.syncNavigation();
}

private productHeaderAction(): SettingsNavigationHeaderAction | undefined {
  const check = this.productUpdateCheck;
  if (!check?.updateAvailable) return undefined;
  return {
    id: "claudepp-update",
    label: "Update",
    title: check.latestVersion
      ? `Open Claude++ ${check.latestVersion} update`
      : "Open Claude++ update",
    onClick: async () => {
      const current = this.productUpdateCheck;
      if (!current?.updateAvailable) return;
      await this.services.openExternal(
        current.releaseUrl || CLAUDE_PLUSPLUS_RELEASES_URL,
      );
    },
  };
}
~~~

Set the `CLAUDE++` group's `headerAction` from this method. Pass a bound
`setProductUpdateCheck: (check) => this.setProductUpdateCheck(check)` into built-in page context. In
`createLoadingSettingsProductServices`, use an exact pre-wiring implementation that throws
`new Error("Claude++ external-open service is unavailable")`; production services in the injector must replace it
with `openExternal: (url) => managementInvoke("claudepp:open-external", url)`.

- [ ] **Step 6: Publish forced Config results through the same setter**

Extend `ConfigPageContext`:

~~~ts
publishProductUpdate(check: ClaudePlusPlusUpdateCheck | null): void;
~~~

Change only the product `Check Now` callback:

~~~ts
const result = await context.invoke<ClaudePlusPlusUpdateCheck>(
  "claudepp:check-claudepp-update",
  true,
);
context.publishProductUpdate(result);
if (!context.root.isConnected) return;
await renderConfigPage(context);
~~~

The connected-root guard affects only the post-result Config rerender; publication still goes through the
generation-safe setter first. Do not change `Download Update`, channel saving, automatic-refresh, or Watcher controls.

- [ ] **Step 7: Orchestrate visually eligible navigation mounts with an environment generation**

Increment a module-level generation inside `resetEnvironment` before it disposes an environment. When creating an
adapter/controller, capture the current generation and controller identity:

~~~ts
const generation = settingsEnvironmentGeneration;
let localController!: SettingsProductController;
const isCurrent = (): boolean =>
  settingsEnvironmentGeneration === generation && controller === localController;

const publishProductUpdate = (check: ClaudePlusPlusUpdateCheck | null): void => {
  if (isCurrent()) localController.setProductUpdateCheck(check);
};
~~~

Assign `controller = localController`, install the navigation-mount listener, and only then call
`localController.start()`. The callback therefore runs after the group DOM is attached but before injector setup
returns. Keep a pending bit for a hidden mount, then install the visibility listener after `start()` so initial
navigation remains synchronous. Use `publishProductUpdate` in the Config page context:

~~~ts
let productCheckPendingForMount = false;
const startProductCheck = (): void => {
  void managementInvokeTyped<ClaudePlusPlusUpdateCheck>(
    "claudepp:check-claudepp-update",
    false,
  )
    .then((check) => publishProductUpdate(check))
    .catch(() => publishProductUpdate(null));
};

adapter.setNavigationMountListener((visible) => {
  productCheckPendingForMount = !visible;
  if (visible) startProductCheck();
});
localController.start();
adapter.setVisibilityListener((visible) => {
  if (!visible || !productCheckPendingForMount) return;
  productCheckPendingForMount = false;
  startProductCheck();
});
~~~

The adapter invokes the mount listener for initial mount and group/shell remount, but not while its owned group remains
attached. The visibility listener releases exactly one pending hidden mount. This matches Codex++'s visible-sidebar and
early-return branches. Do not await the promise and do not retain a Renderer product TTL. The local catch belongs to the
product-check IPC, not to the Update action click.

- [ ] **Step 8: Run focused Settings tests and verify GREEN**

~~~powershell
node --import tsx --test packages/runtime/test/claude-settings-shell-adapter.test.ts packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-config-page.test.ts packages/runtime/test/settings-injector.test.ts
~~~

Expected: PASS with visually eligible navigation-mounted product checks, hidden-mount deferral, attached-group and observer-feedback suppression, one review action, official fallback URL, current URL dereference, manual/automatic shared state, completion-order overlap, and disposed-environment containment.

- [ ] **Step 9: Commit the product indicator**

~~~powershell
git add packages/runtime/src/settings/types.ts packages/runtime/src/settings/product-controller.ts packages/runtime/src/settings/config-page.ts packages/runtime/src/preload/settings-injector.ts packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-config-page.test.ts packages/runtime/test/settings-injector.test.ts
git commit -m "feat: show Claude++ update indicator"
~~~

---

### Task 7: Store Warm and Proactive Update Badge

**Files:**
- Modify: `packages/runtime/src/settings/store-page.ts`
- Modify: `packages/runtime/src/preload/settings-injector.ts`
- Modify: `packages/runtime/test/settings-store-page.test.ts`
- Modify: `packages/runtime/test/settings-injector.test.ts`
- Modify: `packages/runtime/test/settings-product-controller.test.ts`

**Interfaces:**
- Produces: `StoreDataContext { invoke, setStoreUpdateCount }`.
- Produces: `warmTweakStore(context): void`, which starts the shared request and attaches only the Codex++-matching success continuation.
- Produces: `countStoreUpdates(store) => number` shared by warm and page render.
- Consumes: Task 5's visual-visibility listener and Task 6's generation-safe controller publisher.
- Preserves: existing `cachedStore`/`storePromise`, forced Refresh, install decrement, 900 ms delayed force refresh, and last-completion cache behavior.

- [ ] **Step 1: Write failing Store warm/cache tests**

Import `clearStoreCache` and the new warm function, and clear module state before/after every cache-sensitive test:

~~~ts
test("warm and normal page render share one in-flight Store request", async () => {
  clearStoreCache();
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const gate = deferred<TweakStoreRegistryView>();
  let requests = 0;
  const page = context(root, [], async (channel: string) => {
    assert.equal(channel, "claudepp:get-tweak-store");
    requests += 1;
    return await gate.promise;
  });
  warmTweakStore(page);
  const render = renderStorePage(page);
  assert.equal(requests, 1);
  gate.resolve(registry([installedEntry("com.example.old", "0.1.0", "0.2.0")]));
  await render;
  assert.equal(page.publishedCounts.at(-1), 1);
  clearStoreCache();
});

test("a normal Store render failure clears the count and a later render retries", async () => {
  clearStoreCache();
  const fixture = settingsFixture();
  let requests = 0;
  const page = context(
    fixture.environment.document.createElement("div"),
    [],
    async () => {
      requests += 1;
      if (requests === 1) throw new Error("offline");
      return registry([]);
    },
  );
  page.setStoreUpdateCount(3);
  await renderStorePage(page);
  assert.equal(page.publishedCounts.at(-1), 0);
  assert.match(page.root.textContent ?? "", /Could not load Tweak Store.*offline/);
  await renderStorePage(page);
  assert.equal(requests, 2);
  assert.match(page.root.textContent ?? "", /No tweaks yet/);
  clearStoreCache();
});
~~~

Change the existing test-only `context` helper to expose every published count without changing its call sites:

~~~ts
type StoreInvokeFixture = (
  channel: string,
  ...args: unknown[]
) => Promise<unknown>;

function context(
  root: HTMLElement,
  calls: string[] = [],
  invokeFixture: StoreInvokeFixture = async () => undefined,
): StorePageContext & { publishedCounts: number[] } {
  const publishedCounts: number[] = [];
  return {
    root,
    publishedCounts,
    setStoreUpdateCount(count: number) { publishedCounts.push(count); },
    promptRepo: () => null,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      if (channel === "claudepp:install-store-tweak") calls.push(String(args[0]));
      return (await invokeFixture(channel, ...args)) as T;
    },
  };
}

function installedEntry(id: string, installed: string, latest: string): TweakStoreEntryView {
  const base = entry(id, id);
  return {
    ...base,
    manifest: { ...base.manifest, version: latest },
    installed: { version: installed, enabled: true },
  };
}
~~~

Use the shared `Deferred<T>` helper and the existing complete `registry`/`entry` builders. Add a local exact-text
button finder when exercising Refresh or Update.
Import `beforeEach`/`afterEach` from `node:test`, `TweakStoreRegistryView`, and `clearStoreCache` as needed. Register
`afterEach(() => clearStoreCache())` in both Store-page and injector suites. In the injector suite, replace the old
rejecting reset bridge with a Store-aware baseline installed in `beforeEach` and restored in `afterEach`:

~~~ts
const emptyStoreRegistry: TweakStoreRegistryView = {
  schemaVersion: 1,
  sourceUrl: "https://example.com/store.json",
  fetchedAt: "2026-08-22T00:00:00.000Z",
  entries: [],
};

async function baselineManagementBridge(channel: string): Promise<unknown> {
  if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
  throw new Error(`unexpected ${channel}`);
}

beforeEach(() => setSettingsManagementBridge(baselineManagementBridge));
afterEach(() => {
  clearStoreCache();
  setSettingsManagementBridge(baselineManagementBridge);
});
~~~

The automatic product path contains this baseline rejection; the Store path resolves with a valid empty registry.
Update every custom bridge used with a visible fixture so it also handles `claudepp:get-tweak-store`, whether with this
empty registry or the test's deferred Store value. This prevents strict production rejection semantics from creating
unrelated unhandled rejections in tests and prevents Renderer-module cache state from leaking between cases.

Do not execute an automatic-warm rejection case in the Node test runner: strict Codex++ parity intentionally leaves
that rejection without a local handler, so such a test would create an unhandled rejection. Verify the success-only
source shape in Task 9, while testing failure cleanup and retry through the caught normal Store-page render path.

Add a deferred-order test:

1. start normal warm A;
2. trigger the page's forced Refresh B;
3. resolve B, then A;
4. render normally and assert A is the final cache.

This explicitly records last-completion behavior. Do not expect B/latest-request to win.

Add an install invalidation test:

1. warm/cache a registry containing an update;
2. render the cached registry and click Update;
3. before any delayed refresh, call `warmTweakStore` again;
4. assert a second `claudepp:get-tweak-store` request occurs and the visible count was decremented first.

- [ ] **Step 2: Write failing injector visibility/old-environment Store tests**

Extend Task 6's bridge so product and Store promises are both deferred. For an initially visible fixture, assert the
navigation group exists before the product request and that both the navigation-triggered product request and
visibility-triggered Store request have started before `startSettingsInjector` returns. For a hidden fixture, assert
neither request has started; make it visible through an observer signal and assert the pending mount starts product and
the same transition starts Store. Add:

- hidden→visible twice reuses Store memory and therefore calls `claudepp:get-tweak-store` once;
- a warm from document A that resolves after a still-hidden document B replaces the environment cannot update B's
  badge; once B becomes visible it may legitimately reuse the Renderer-wide Store promise/cache.

The injector test must verify the automatic call is fire-and-forget and starts in the visibility turn. Do not attach a
rejection callback at the call site; Task 9's Codex++ source-shape audit is the guard for that deliberate behavior.

- [ ] **Step 3: Run focused Store/Settings tests and verify RED**

~~~powershell
node --import tsx --test packages/runtime/test/settings-store-page.test.ts packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-injector.test.ts
~~~

Expected: FAIL because no exported warm path exists and the visibility listener does not yet start Store work.

- [ ] **Step 4: Extract a shared count and Codex++-matching warm operation**

Split the context type without changing page callers:

~~~ts
export interface StoreDataContext {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  setStoreUpdateCount(count: number): void;
}

export interface StorePageContext extends StoreDataContext {
  root: HTMLElement;
  promptRepo(): string | null;
}

export function countStoreUpdates(store: TweakStoreRegistryView): number {
  return store.entries.filter((entry) =>
    entry.installed && entry.installed.version !== entry.manifest.version).length;
}

export function warmTweakStore(context: StoreDataContext): void {
  void getStore(context, false).then((store) => {
    context.setStoreUpdateCount(countStoreUpdates(store));
  });
}
~~~

Change `getStore` to consume `StoreDataContext` and change `renderStore` to call `countStoreUpdates`. Do not catch inside `getStore`; its existing `finally` must clear only the matching in-flight promise so a later warm can retry.

At the start of `renderStoreError`, set `currentStoreUpdateCount = 0` and call
`context.setStoreUpdateCount(currentStoreUpdateCount)` before rendering the explicit error row. This preserves the
caught normal Store-page failure path: it clears the visible count and shows the explicit error row. The automatic warm
path has no corresponding rejection callback.

Keep `clearStoreCache` unchanged. Keep force requests writing the shared `cachedStore`/`storePromise` exactly as they do now. Keep successful install's decrement → publish → clear cache → connected-root delayed force refresh order.

- [ ] **Step 5: Start Store warm from the visual transition**

Extend Task 6's existing visual-visibility listener so the same transition releases a pending product mount before
starting Store warm:

~~~ts
adapter.setVisibilityListener((visible) => {
  if (!visible) return;
  if (productCheckPendingForMount) {
    productCheckPendingForMount = false;
    startProductCheck();
  }
  void warmTweakStore({
    invoke: managementInvokeTyped,
    setStoreUpdateCount: (count) => {
      if (isCurrent()) localController.setStoreUpdateCount(count);
    },
  });
});
~~~

For an initially visible shell, the listener's immediate predicate publication starts Store warm in the same injector
setup turn as the earlier navigation-triggered product check. For a hidden mount, neither starts until visibility becomes
true, then the pending product check starts before Store warm in that callback. Neither request delays navigation. The
generation guard belongs in the callback passed to warm, not inside Store DOM.

- [ ] **Step 6: Run focused Store/Settings tests and verify GREEN**

~~~powershell
node --import tsx --test packages/runtime/test/settings-store-page.test.ts packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-injector.test.ts
~~~

Expected: PASS with one shared normal request, proactive mismatch count, caught page-render retry, retained force/warm race semantics, install invalidation, old-environment containment, and the strict Codex++ success-only automatic-warm source shape.

- [ ] **Step 7: Commit Store warming**

~~~powershell
git add packages/runtime/src/settings/store-page.ts packages/runtime/src/preload/settings-injector.ts packages/runtime/test/settings-store-page.test.ts packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-injector.test.ts
git commit -m "feat: warm Tweak Store updates"
~~~

---

### Task 8: Document the Advisory Contract and Draft 0.3.1 Notes

**Files:**
- Modify: `README.md`
- Modify: `docs/tweaks/manifest.md`
- Modify: `docs/tweaks/runtime-lifecycle.md`
- Modify: `docs/tweaks/distribution-debugging.md`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/0.3.1.md`
- Modify: `test/repository-shape.test.mjs`

**Interfaces:**
- Documents: visually eligible navigation mount/remount product trigger, visual Store trigger, official/saved product sources,
  installed-Tweak timing/cache boundaries, Store cache lifetime, and metadata-only safety promise.
- Records: the five approved Codex++ differences without broadening them.
- Preserves: package/workspace versions at `0.3.0`; this is a release draft, not the version/tag/publication step.

- [ ] **Step 1: Write the failing repository documentation contract**

Add one repository-shape test using direct file reads:

~~~js
test("documents visible review-only update metadata without promising installation", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const manifestGuide = readFileSync(
    new URL("../docs/tweaks/manifest.md", import.meta.url),
    "utf8",
  );
  const lifecycle = readFileSync(
    new URL("../docs/tweaks/runtime-lifecycle.md", import.meta.url),
    "utf8",
  );
  const distribution = readFileSync(
    new URL("../docs/tweaks/distribution-debugging.md", import.meta.url),
    "utf8",
  );
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const releaseNotes = readFileSync(
    new URL("../docs/releases/0.3.1.md", import.meta.url),
    "utf8",
  );

  assert.match(
    readme,
    /navigation group[\s\S]*hidden mount[\s\S]*defer[\s\S]*product metadata[\s\S]*visually visible[\s\S]*Store[\s\S]*JSON metadata/is,
  );
  assert.match(
    readme,
    /Stable and Prerelease[\s\S]*kpkhxlgy0\/claude-plusplus[\s\S]*Custom[\s\S]*saved repository/is,
  );
  assert.match(
    readme,
    /manual Refresh[\s\S]*successful Store installation[\s\S]*Renderer restart/is,
  );
  assert.match(manifestGuide, /entry exists[\s\S]*runtime-incompatible[\s\S]*disabled[\s\S]*checked/is);
  assert.match(
    readme,
    /automatic Store warm[\s\S]*no local rejection handler[\s\S]*Store page[\s\S]*caught/is,
  );
  assert.match(
    readme,
    /missing release URL[\s\S]*kpkhxlgy0\/claude-plusplus\/releases/is,
  );
  assert.match(lifecycle, /parallel[\s\S]*awaited[\s\S]*8 seconds[\s\S]*hot reload/is);
  assert.match(
    distribution,
    /repository[\s\S]*installed version[\s\S]*24 hours[\s\S]*same-identity[\s\S]*in-flight/is,
  );
  assert.doesNotMatch(distribution, /at most once per 24 hours/i);
  assert.match(changelog, /## 0\.3\.1[\s\S]*docs\/releases\/0\.3\.1\.md/);
  assert.match(releaseNotes, /metadata only[\s\S]*never[\s\S]*(archive|executable)[\s\S]*install/is);
  assert.match(releaseNotes, /Watcher and automatic refresh remain off by default/i);
});
~~~

This test intentionally reads the new release-note file immediately, so the baseline fails with `ENOENT` even if a
subset of prose happens to match.

- [ ] **Step 2: Run the repository-shape test and verify RED**

~~~powershell
node --test test/repository-shape.test.mjs
~~~

Expected: FAIL because `docs/releases/0.3.1.md` and the new documentation contract do not exist yet.

- [ ] **Step 3: Update user and Tweak-author documentation**

Use one consistent phrase: automatic checks **download JSON metadata only**. Do not say “nothing is downloaded
automatically,” because release and Store metadata traffic is real.

- In `README.md`, add a “Review-only update indicators” subsection beside the existing Settings/update material. State
  that mounting or remounting the Claude++ navigation group starts product metadata once that mount is visually visible;
  a hidden mount defers it. The reviewed Store starts on the visual false-to-true transition. For an initially visible
  shell both start before injector setup returns, and navigation waits for neither. State that the Claude++ heading opens the
  current GitHub release for review, or `https://github.com/kpkhxlgy0/claude-plusplus/releases` when the result has a
  missing release URL; the Store item shows installed-version mismatches; Stable/Prerelease use
  `kpkhxlgy0/claude-plusplus`, while Custom uses its saved repository; and Store memory survives reopening Settings until
  manual Refresh, successful Store installation, or Renderer restart.
- In the same README subsection, state that metadata checks never download a release archive or executable, install an
  update, enable Watcher, or change automatic-refresh/settings state. State that Config `Check Now` publishes through
  the same controller-owned product state and validity-aware advisory writer. Keep the existing opt-in maintenance text.
- In `docs/tweaks/manifest.md`, document that every installed Tweak whose entry exists is automatically checked;
  runtime-incompatible and disabled rows are not filtered out. A missing-entry diagnostic row starts no request. Define
  the identity as config path + manifest id + `githubRepo` + installed version and explain that diagnostic rows receive
  cached data only for matching repository and installed version.
- In `docs/tweaks/runtime-lifecycle.md`, place the check after installed discovery and before the catalog response.
  Explain that entry-present checks run in parallel but are awaited, so a stale cache can delay initial Renderer Tweak
  startup or Renderer hot reconstruction by the slowest GitHub request, bounded at about 8 seconds. A completed result
  still reaches the current catalog response when persistence is refused.
- In `docs/tweaks/distribution-debugging.md`, explain that a matching persistent id/repository/installed-version result
  younger than 24 hours is reused; overlapping same-identity calls share only their in-flight promise; the promise is
  removed after settlement; and invalid/unreadable/unwritable config can cause a later sequential call or process to
  request metadata again. Record that distinct product/Tweak slots and intervening valid config changes merge at
  completion time, while same-id/different-identity checks retain one-slot last-completion behavior. Clarify that the
  indicator is a GitHub review link, not an installer.
- In the README and release draft, explicitly record the Codex++ failure boundary: automatic Store warm attaches only a
  success continuation and has no local rejection handler; an explicit Store-page render catches load failure, clears
  the badge, and renders its error state.
- In the release draft, record that the fire-and-forget product Update click also has no local rejection handler,
  while the automatic product-check IPC does catch rejection and hides the action.

- [ ] **Step 4: Draft changelog and release notes without bumping packages**

Add `## 0.3.1` at the top of `CHANGELOG.md`, linking `docs/releases/0.3.1.md`, with:

- **Added:** visible Claude++ release action and proactive reviewed-Store mismatch badge.
- **Changed:** entry-present installed-Tweak catalog checks are parallel and awaited, with exact-identity in-flight
  sharing and current-batch results.
- **Fixed:** automatic/forced advisory writes preserve malformed, non-object, and unreadable config while containing
  write failure.
- **Security:** automatic traffic is metadata-only and never enters archive/install/Watcher/settings mutation paths.

Create `docs/releases/0.3.1.md` with sections “Highlights,” “Timing and cache behavior,” “Safety boundaries,” and
“Install or update.” Explicitly call it a draft until the later version/tag step. Cover the five approved differences,
the possible roughly eight-second Renderer startup/hot-reload delay, last-completion rules, all Store invalidation
events, runtime-incompatible entry-present checks, visually eligible navigation mount/remount product timing, the official missing-URL
fallback, and both success-only fire-and-forget rejection boundaries. The install section must point at the future
`claude-plusplus-0.3.1-win-x64.zip` without claiming it already exists.

Do not modify `package.json`, `package-lock.json`, or workspace package versions in this task.

- [ ] **Step 5: Run the repository documentation contract and verify GREEN**

~~~powershell
node --test test/repository-shape.test.mjs
git diff --check
~~~

Expected: PASS; the existing repository version test still requires `0.3.0`, and the documentation consistently says
metadata-only rather than no automatic download.

- [ ] **Step 6: Commit documentation and the release draft**

~~~powershell
git add README.md CHANGELOG.md docs/tweaks/manifest.md docs/tweaks/runtime-lifecycle.md docs/tweaks/distribution-debugging.md docs/releases/0.3.1.md test/repository-shape.test.mjs
git commit -m "docs: explain advisory update checks"
~~~

---

### Task 9: Full Regression, Codex++ Comparison, and Review Gate

**Files:**
- Verify only; modify no file unless a concrete test or review finding requires a focused fix.

**Interfaces:**
- Validates: every design requirement, every approved divergence, Windows packaging, and live-profile isolation.
- Produces: evidence for a later user decision to version, push, or publish; this task performs none of those actions.

- [ ] **Step 1: Re-inspect Codex++ and audit divergence boundaries**

Read the installed reference again, not cached notes:

- `C:\Users\Admin\.codex-plusplus\source\packages\runtime\src\main.ts:565-575,1066-1115` for parallel awaited
  installed-Tweak checks, 24-hour identity cache, eight-second request timeout, and product endpoint behavior.
- `C:\Users\Admin\.codex-plusplus\source\packages\runtime\src\preload\settings-injector.ts:401-450,690-720,1668-1693,1984-2059,2939-2993`
  for visually eligible navigation mount/remount product checks and the attached-group early return, visual Store
  trigger, official missing-URL fallback, product-click and
  Store-warm rejection shapes, in-flight cleanup, mismatch count, and visible state.

Compare those paths with the implementation diff and record exactly five intentional differences: validity-aware
advisory persistence, exact-identity in-flight sharing, official Stable/Prerelease plus existing release-list
selection, commit-time merge, and Config `Check Now` safe persistence. If a sixth behavioral difference appears, stop
and return to the user for explicit approval before retaining it.

As explicit parity checks, verify that every entry-present Tweak is requested even when runtime-incompatible; product
checks follow visually eligible navigation group mount/remount rather than Store visibility alone or ordinary
attached-group synchronization; a missing product release URL keeps the action and opens
`https://github.com/kpkhxlgy0/claude-plusplus/releases`; and neither product-action click nor automatic Store warm has a
local rejection callback or `.catch`. None is an approved divergence.

- [ ] **Step 2: Run all focused Main/runtime tests**

~~~powershell
node --import tsx --test packages/runtime/test/config.test.ts packages/runtime/test/tweak-update.test.ts packages/runtime/test/tweak-catalog.test.ts packages/runtime/test/update-service.test.ts packages/runtime/test/management-ipc.test.ts packages/runtime/test/main.test.ts packages/runtime/test/advisory-update-concurrency.test.ts
~~~

Expected: PASS with no network access, no live-profile writes, and no real eight-second wait.

- [ ] **Step 3: Run all focused Settings/preload tests**

~~~powershell
node --import tsx --test packages/runtime/test/claude-settings-shell-adapter.test.ts packages/runtime/test/settings-product-controller.test.ts packages/runtime/test/settings-config-page.test.ts packages/runtime/test/settings-store-page.test.ts packages/runtime/test/settings-injector.test.ts
npm run build --workspace @claude-plusplus/runtime
node --test packages/runtime/test/preload-sandbox.test.mjs
~~~

Expected: PASS; navigation is synchronous, product metadata failures are detached and contained, Store warm is detached
with the intentional Codex++ success-only rejection semantics, and the built preload has the required browser globals
without unexpected IPC.

- [ ] **Step 4: Run the complete repository suite**

~~~powershell
npm test
~~~

Expected: PASS for every workspace and root test. Do not weaken or skip unrelated failures; diagnose them before
continuing.

- [ ] **Step 5: Build and smoke-test the Windows archive**

~~~powershell
npm run package:windows
pwsh -NoProfile -File scripts/test-windows-package.ps1
~~~

Expected: both commands exit zero. Before running, inspect the smoke script's existing `APPDATA`, `LOCALAPPDATA`, and
`USERPROFILE` redirection plus contained-path assertions; its success then proves operations stayed in its disposable
test root. Do not run the installed Watcher or launch the live Claude Desktop application.

- [ ] **Step 6: Request an independent implementation review**

Invoke `superpowers:requesting-code-review` and give the reviewer the design spec, this plan, and the implementation
diff. Ask specifically for:

- unapproved Codex++ divergence;
- unsafe malformed/unreadable config handling;
- in-flight map leaks or wrong Tweak eligibility, including accidental runtime-compatibility filtering;
- stale Settings environment callbacks or stale release URLs;
- product checks missing mount/remount identity, failing to defer a hidden mount, retriggering while the owned group is
  attached, missing the official fallback URL, or adding a local product-click rejection handler;
- same-shell MutationObserver feedback caused by unconditional writes to observed navigation attributes;
- accidental archive/install/Watcher/settings mutation;
- missing Store cache invalidation, completion-order coverage, or live-profile isolation;
- an accidental `.catch` or rejection callback on automatic Store warm.

Resolve every confirmed finding. After any source fix, rerun the affected focused command, `npm test`, and Windows
package smoke before claiming completion.

- [ ] **Step 7: Audit the final diff and working tree**

Use the committed plan as the implementation base:

~~~powershell
$implementationBase = git log -1 --format=%H -- docs/superpowers/plans/2026-08-22-visible-review-only-updates.md
git diff --check "$implementationBase..HEAD"
git diff --stat "$implementationBase..HEAD"
git diff --name-only "$implementationBase..HEAD"
git status --short --branch
~~~

Expected: `git diff --check` exits zero; changed files are limited to Tasks 1–8 plus any focused reviewed test fix;
the working tree is clean; no package version changed; and no generated archive is tracked.

- [ ] **Step 8: Stop at the release boundary**

Report focused/full/package evidence and any retained known behavior (including the possible roughly eight-second stale
catalog delay). Do not bump versions, push `master`, tag, create a GitHub release, or install the package until the user
explicitly chooses that next step.
