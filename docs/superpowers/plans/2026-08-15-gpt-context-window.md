# GPT Context Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a restart-gated Claude++ startup-environment capability and a standalone GPT Context Window Tweak that safely configures Claude Desktop's client-side context and automatic-compaction thresholds.

**Architecture:** Claude++ validates a declarative manifest permission, reads versioned per-Tweak snapshots synchronously before Claude's original main entry, and exposes a lease-scoped Main API after readiness. The standalone Tweak owns all GPT-specific defaults, validation, IPC, and settings UI; Claude++ core remains generic and never executes Tweak JavaScript during early startup.

**Tech Stack:** TypeScript 5.9, Node.js 24+ built-in test runner, Electron 41 types, CommonJS Tweak JavaScript, PowerShell 7 Junction maintenance, Git.

## Global Constraints

- Codex++ is the reference implementation for manifest validation, permission gating, storage, settings registration, lifecycle cleanup, and restart UX.
- The only approved Codex++ divergence is the permission-gated startup-environment bridge that runs before Claude's original main entry.
- Claude++ target version is `0.2.4`; the Tweak must declare `minRuntime: "0.2.4"`.
- Tweak display name is `GPT Context Window`; Tweak ID is `com.kpk.gpt-context-window`.
- Tweak source root is `D:\workspace\sgproj\FilePackages\gpt-context-window` and the installed path is a Junction at `%APPDATA%\claude-plusplus\tweaks\com.kpk.gpt-context-window`.
- Initial internal state is disabled, with defaults `272000`, `250000`, and `85` prefilled.
- All three variables are an atomic group: any validation, ownership, or conflict failure applies none of them.
- The feature is process-wide. It does not claim per-model or per-session isolation.
- Saving never changes the current Claude process; a complete restart is required.
- Never write Windows user/system environment variables, the registry, or `~/.claude/settings.json`.
- Do not add server-side compaction, CC-Switch changes, or a local proxy.
- Do not tag, push, publish a GitHub release, create a remote repository, or submit Perforce without explicit user authorization in the execution turn.

---

## File Structure

### Claude++ core (`D:\Unity\ClaudePlusPlus`)

- Modify `packages/sdk/src/index.ts`: public manifest, permission, configuration, status, and API contracts.
- Modify `packages/sdk/test/manifest-validation.test.ts`: permission/declaration contract and public type coverage.
- Create `packages/runtime/src/startup-environment-store.ts`: path containment, snapshot parsing, and atomic persistence.
- Create `packages/runtime/test/startup-environment-store.test.ts`: snapshot storage and corruption cases.
- Create `packages/runtime/src/startup-environment.ts`: eligibility, conflict detection, baseline capture/application, status, save, and relaunch.
- Create `packages/runtime/test/startup-environment.test.ts`: gate matrix, atomic-group behavior, restore, relaunch, and diagnostics.
- Modify `packages/runtime/src/main.ts`: synchronous pre-host initialization and injection into Main Tweak leases.
- Modify `packages/runtime/src/tweak-api.ts`: permission-gated lease-scoped `startupEnvironment` API.
- Modify `packages/runtime/test/tweak-api.test.ts`: permission and post-disposal revocation coverage.
- Modify `packages/loader/test/loader.test.cjs`: built-runtime-before-original-entry environment assertion.
- Modify version/release files listed in Task 4 for Claude++ `0.2.4`.

### Standalone Tweak (`D:\workspace\sgproj\FilePackages\gpt-context-window`)

- Create `manifest.json`: identity, minimum runtime, permissions, and owned keys.
- Create `index.js`: GPT configuration validation, Main IPC, settings page, and lifecycle.
- Create `test/index.test.js`: behavior, Main, Renderer, and cleanup tests.
- Create `package.json`: local test command and metadata.
- Create `Inject-ClaudePlusPlus.ps1` and `Uninject-ClaudePlusPlus.ps1`: safe Junction-only maintenance.
- Create `scripts/TweakLink.psm1`: link classification, creation, replacement, and removal.
- Create `scripts/test/TweakLink.Tests.ps1`: Junction safety and check-only integration.
- Create `scripts/compatibility/validate-claudeplusplus.mjs`: source-runtime compatibility gate.
- Create `scripts/compatibility/validate-claudeplusplus.test.mjs`: compatibility harness tests.
- Create `.gitignore`, `LICENSE`, `README.md`, and `README.zh-CN.md`: repository and usage documentation.

---

### Task 1: Define the Claude++ public startup-environment contract

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/test/manifest-validation.test.ts`

**Interfaces:**
- Produces: `StartupEnvironmentDeclaration`, `StartupEnvironmentConfig`, `StartupEnvironmentStatus`, and `StartupEnvironmentApi`.
- Produces: `TweakManifest.startupEnvironment?: StartupEnvironmentDeclaration`.
- Produces: `TweakApi.startupEnvironment?: StartupEnvironmentApi`.
- Produces: permission string `startup-environment`.

- [ ] **Step 1: Add failing manifest validation tests**

Add cases that require the permission and declaration together, accept three unique Windows-compatible keys, reject
duplicates, reject invalid names, and reject Renderer-only ownership:

```ts
test("accepts a Main-capable startup environment declaration", () => {
  const result = validateTweakManifest({
    id: "com.example.startup-env",
    name: "Startup env",
    version: "0.1.0",
    githubRepo: "example/startup-env",
    scope: "both",
    permissions: ["startup-environment"],
    startupEnvironment: { keys: ["EXAMPLE_ONE", "EXAMPLE_TWO"] },
  });
  assert.equal(result.ok, true);
});

for (const manifest of [
  { permissions: ["startup-environment"] },
  { startupEnvironment: { keys: ["EXAMPLE_ONE"] } },
  { permissions: ["startup-environment"], startupEnvironment: { keys: ["BAD=KEY"] } },
  { permissions: ["startup-environment"], startupEnvironment: { keys: ["DUP", "DUP"] } },
  {
    scope: "renderer",
    permissions: ["startup-environment"],
    startupEnvironment: { keys: ["EXAMPLE_ONE"] },
  },
]) {
  const result = validateTweakManifest({
    id: "com.example.invalid-startup-env",
    name: "Invalid startup env",
    version: "0.1.0",
    githubRepo: "example/invalid-startup-env",
    scope: "both",
    ...manifest,
  });
  assert.equal(result.ok, false);
}
```

- [ ] **Step 2: Run the SDK test and verify failure**

Run:

```powershell
node --import tsx --test packages/sdk/test/manifest-validation.test.ts
```

Expected: FAIL because `startup-environment` and `startupEnvironment` are not recognized.

- [ ] **Step 3: Add the public types and exact manifest validation**

Add these contracts to `packages/sdk/src/index.ts`:

```ts
export interface StartupEnvironmentDeclaration {
  keys: string[];
}

export interface StartupEnvironmentConfig {
  enabled: boolean;
  variables: Record<string, string>;
}

export interface StartupEnvironmentStatus {
  saved: StartupEnvironmentConfig | null;
  applied: StartupEnvironmentConfig | null;
  restartRequired: boolean;
  error?: string;
}

export interface StartupEnvironmentApi {
  getStatus(): StartupEnvironmentStatus;
  save(config: StartupEnvironmentConfig): StartupEnvironmentStatus;
  relaunch(): void;
}
```

Extend the existing contracts exactly:

```ts
export const VALID_TWEAK_PERMISSIONS = [
  "ipc",
  "filesystem",
  "network",
  "settings",
  "claude-sessions",
  "startup-environment",
] as const;

export interface TweakManifest {
  // existing fields remain unchanged
  startupEnvironment?: StartupEnvironmentDeclaration;
}

export interface TweakApi {
  // existing fields remain unchanged
  startupEnvironment?: StartupEnvironmentApi;
}
```

Use `^[A-Za-z_][A-Za-z0-9_]*$` for key names. Require at least one unique key. Require `scope` to be `main` or `both`.
Require the declaration if and only if the permission is present.

- [ ] **Step 4: Extend the public API fixture and run SDK build/tests**

Construct a `StartupEnvironmentApi` fixture in `public API contracts support...`, attach it to `TweakApi`, and assert
that `getStatus`, `save`, and `relaunch` retain their declared return types.

Run:

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/sdk/test/manifest-validation.test.ts
```

Expected: TypeScript build succeeds and all SDK tests PASS.

- [ ] **Step 5: Commit the SDK contract**

```powershell
git add packages/sdk/src/index.ts packages/sdk/test/manifest-validation.test.ts
git commit -m "feat: define startup environment tweak API"
```

---

### Task 2: Persist versioned startup-environment snapshots atomically

**Files:**
- Create: `packages/runtime/src/startup-environment-store.ts`
- Create: `packages/runtime/test/startup-environment-store.test.ts`

**Interfaces:**
- Consumes: `StartupEnvironmentConfig` from Task 1.
- Produces: `STARTUP_ENVIRONMENT_SNAPSHOT_VERSION = 1`.
- Produces: `readStartupEnvironmentSnapshot(userRoot, manifest): StartupEnvironmentSnapshotRead`.
- Produces: `writeStartupEnvironmentSnapshot(userRoot, manifest, config): void`.
- Produces: `startupEnvironmentSnapshotPath(userRoot, manifestId): string`.

- [ ] **Step 1: Write failing storage tests**

Cover exact path, no-file status, round-trip, atomic replacement, malformed JSON, unknown version, an ignored unknown
top-level field, undeclared variable key, missing declared variable key, and non-string value:

```ts
test("round-trips one complete declared snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-startup-store-"));
  try {
    const config = {
      enabled: true,
      variables: { EXAMPLE_MAX: "272000", EXAMPLE_WINDOW: "250000" },
    };
    writeStartupEnvironmentSnapshot(root, manifest, config);
    assert.equal(
      startupEnvironmentSnapshotPath(root, manifest.id),
      join(root, "startup-environment", `${manifest.id}.json`),
    );
    assert.deepEqual(readStartupEnvironmentSnapshot(root, manifest), { config });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

For invalid files, assert `{ config: null, error: /specific reason/ }` and verify no rename or rewrite occurs during
read.

- [ ] **Step 2: Run the new test and verify module-not-found failure**

```powershell
node --import tsx --test packages/runtime/test/startup-environment-store.test.ts
```

Expected: FAIL because `startup-environment-store.ts` does not exist.

- [ ] **Step 3: Implement the focused snapshot store**

Define the internal result and envelope:

```ts
export const STARTUP_ENVIRONMENT_SNAPSHOT_VERSION = 1;

interface StartupEnvironmentSnapshotDocument {
  version: 1;
  enabled: boolean;
  variables: Record<string, string>;
}

export interface StartupEnvironmentSnapshotRead {
  config: StartupEnvironmentConfig | null;
  error?: string;
}
```

Requirements for `readStartupEnvironmentSnapshot`:

- derive `startup-environment/<validated-id>.json` under `userRoot`;
- return `{ config: null }` for a missing file;
- reject a non-object, version other than `1`, non-boolean `enabled`, missing/extra variable keys, or non-string value;
- ignore unknown top-level fields for forward compatibility;
- never modify a bad file while reading;
- return sanitized error text without including values.

Requirements for `writeStartupEnvironmentSnapshot`:

- validate that variables contain exactly the declared keys;
- create the directory;
- write `${file}.staging-${randomUUID()}` with a final newline;
- rename the staging file over the destination;
- remove only the explicit staging path in `finally`.

- [ ] **Step 4: Run focused and adjacent storage tests**

```powershell
node --import tsx --test packages/runtime/test/startup-environment-store.test.ts packages/runtime/test/storage.test.ts
```

Expected: all tests PASS and no staging file remains.

- [ ] **Step 5: Commit the store**

```powershell
git add packages/runtime/src/startup-environment-store.ts packages/runtime/test/startup-environment-store.test.ts
git commit -m "feat: persist startup environment snapshots"
```

---

### Task 3: Apply overlays before Claude and expose a revocable Main API

**Files:**
- Create: `packages/runtime/src/startup-environment.ts`
- Create: `packages/runtime/test/startup-environment.test.ts`
- Modify: `packages/runtime/src/main.ts`
- Modify: `packages/runtime/src/tweak-api.ts`
- Modify: `packages/runtime/test/tweak-api.test.ts`
- Modify: `packages/loader/test/loader.test.cjs`

**Interfaces:**
- Consumes: Task 1 SDK contracts and Task 2 store functions.
- Produces: `initializeStartupEnvironment(options): StartupEnvironmentService`.
- Produces: `StartupEnvironmentService.createApiLease(manifest): StartupEnvironmentApiLease`.
- Produces: `StartupEnvironmentApiLease = { api: StartupEnvironmentApi; dispose(): void }`.
- Changes: `MainTweakApiOptions.startupEnvironment: StartupEnvironmentService`.
- Changes: `RuntimeBootstrapDeps.startupEnvironment: StartupEnvironmentService`.

- [ ] **Step 1: Write failing gate, conflict, baseline, and relaunch tests**

Use an injected `env: Record<string, string | undefined>`, fake log, and fake app bridge. Required cases:

```ts
test("applies one complete eligible overlay and restores its exact baseline", () => {
  const env = { EXAMPLE_MAX: "original", EXAMPLE_WINDOW: undefined };
  const service = initializeFixture({ env, config: saved(true) });
  assert.deepEqual(env, { EXAMPLE_MAX: "272000", EXAMPLE_WINDOW: "250000" });
  assert.deepEqual(service.getStatus(manifest.id).applied, saved(true));
  service.restoreBaseline();
  assert.deepEqual(env, { EXAMPLE_MAX: "original", EXAMPLE_WINDOW: undefined });
});

test("skips every snapshot participating in an ownership conflict", () => {
  const service = initializeFixture({
    manifests: [manifestFor("com.example.one", ["SHARED", "ONE"]), manifestFor("com.example.two", ["SHARED"])],
    snapshots: {
      "com.example.one": config({ SHARED: "one", ONE: "one" }),
      "com.example.two": config({ SHARED: "two" }),
    },
  });
  assert.equal(service.getStatus("com.example.one").applied, null);
  assert.equal(service.getStatus("com.example.two").applied, null);
  assert.equal(processedEnv.SHARED, undefined);
  assert.equal(processedEnv.ONE, undefined);
});
```

Also test Safe Mode, globally disabled Tweak, internally disabled snapshot, missing source, malformed snapshot, save without
permission, save with partial keys, changed saved/applied comparison, one assignment failing midway through a snapshot,
an unexpected initializer failure, relaunch before app attachment, a second conflicting app attachment, and relaunch call
order: `restore baseline -> app.relaunch() -> app.quit()`.

- [ ] **Step 2: Run the focused service test and verify failure**

```powershell
node --import tsx --test packages/runtime/test/startup-environment.test.ts
```

Expected: FAIL because `initializeStartupEnvironment` is undefined.

- [ ] **Step 3: Implement the startup service without importing Tweak code**

Define the host-facing contracts:

```ts
export interface StartupEnvironmentAppBridge {
  relaunch(): void;
  quit(): void;
}

export interface StartupEnvironmentApiLease {
  api: StartupEnvironmentApi;
  dispose(): void;
}

export interface StartupEnvironmentService {
  createApiLease(manifest: TweakManifest): StartupEnvironmentApiLease;
  getStatus(id: string): StartupEnvironmentStatus;
  attachAppBridge(app: StartupEnvironmentAppBridge): void;
  restoreBaseline(): void;
}

export function initializeStartupEnvironment(options: {
  userRoot: string;
  env: NodeJS.ProcessEnv;
  log: TweakLogger;
  app?: StartupEnvironmentAppBridge;
}): StartupEnvironmentService;
```

Initialization must synchronously:

1. read `config.json`;
2. return an inert service in Safe Mode;
3. discover Main-capable Tweaks through existing manifest validation without requiring their JavaScript;
4. exclude globally disabled, internally disabled, missing, incompatible, or invalid candidates;
5. detect shared declared keys among remaining enabled snapshots;
6. skip every complete snapshot involved in a conflict;
7. capture each key as present/string or absent before the first assignment;
8. apply each remaining complete snapshot and retain the applied status.

Apply each Tweak's variables transactionally: if any assignment fails, restore every key in that Tweak's group before
continuing. If an unexpected bridge-level failure escapes candidate processing, restore every overlay already applied and
return an inert error service so Claude's original entry still loads with the incoming environment. Diagnostics may include
Tweak IDs and key names, but never environment values.

`save` atomically writes the next-launch config and recomputes `restartRequired` without mutating `env` or `applied`.
`attachAppBridge` binds Electron only after normal bootstrap begins; a second attachment with a different object fails
closed. `relaunch` before attachment throws a sanitized unavailable error. After attachment it restores the baseline,
calls `app.relaunch()`, then calls `app.quit()`. If scheduling throws, reapply the previously applied overlay before
rethrowing so the still-running process keeps its original launch behavior.

- [ ] **Step 4: Add failing Main API permission and revocation tests**

Extend `packages/runtime/test/tweak-api.test.ts`:

```ts
test("Main API exposes startup environment only with permission and revokes retained references", async () => {
  const withoutPermission = createMainTweakApiLease(optionsFor(manifest([])));
  assert.equal(withoutPermission.api.startupEnvironment, undefined);

  const withPermission = createMainTweakApiLease(optionsFor(startupManifest()));
  const retained = withPermission.api.startupEnvironment;
  assert.ok(retained);
  await withPermission.dispose();
  assert.throws(() => retained.getStatus(), /disposed/);
  assert.throws(() => retained.save(defaultConfig), /disposed/);
  assert.throws(() => retained.relaunch(), /disposed/);
});
```

- [ ] **Step 5: Wire the service into Main Tweak leases**

Add `startupEnvironment: StartupEnvironmentService` to `MainTweakApiOptions`. When the manifest includes the new
permission, call `service.createApiLease(manifest)` and expose its API. Dispose that lease before or alongside IPC and
storage disposal. Do not expose the API to Renderer leases.

At the start of `bootstrapRuntime`, attach an app bridge backed by `deps.electron.app.relaunch()` and
`deps.electron.app.quit()`. Pass the same service through `bootstrapRuntime` to every `createMainTweakApiLease` call.

- [ ] **Step 6: Add a failing loader ordering integration test**

Build the runtime, copy `packages/runtime/dist/main.js` into a temporary `userRoot/runtime`, create an enabled fixture
manifest and snapshot under that root, and make `original.cjs` export the three values:

```js
writeFileSync(join(app, "original.cjs"), `
module.exports = {
  max: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  pct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
};
`);
assert.deepEqual(JSON.parse(run.stdout), { max: "272000", window: "250000", pct: "85" });
```

Run:

```powershell
npm run build --workspace @claude-plusplus/runtime
node --test packages/loader/test/loader.test.cjs
```

Expected before the next step: FAIL because runtime startup has not invoked the service synchronously.

- [ ] **Step 7: Initialize the service synchronously before normal bootstrap**

At runtime module top level, when both `CLAUDE_PLUSPLUS_USER_ROOT` and `CLAUDE_PLUSPLUS_RUNTIME` exist, construct the
logger and call `initializeStartupEnvironment` before the module returns. Reuse that service inside the later Electron-only
`bootstrapRuntime`; do not create a second service after `app.whenReady()`.

Keep ordinary Main Tweaks in their existing post-`app.whenReady()` lifecycle. The early path may read local files and
assign `process.env` only; it must not require Electron, perform network work, or load Tweak entries.
Create the log directory before constructing the early logger, because `createLogger` writes synchronously and the normal
bootstrap has not created `%APPDATA%\claude-plusplus\log` yet.

- [ ] **Step 8: Run focused tests and the full Claude++ suite**

```powershell
node --import tsx --test packages/runtime/test/startup-environment-store.test.ts packages/runtime/test/startup-environment.test.ts packages/runtime/test/tweak-api.test.ts packages/runtime/test/main.test.ts
npm test
```

Expected: all tests PASS, including existing ordinary Tweak readiness/lifecycle tests.

- [ ] **Step 9: Commit the core runtime capability**

```powershell
git add packages/runtime/src/startup-environment.ts packages/runtime/src/main.ts packages/runtime/src/tweak-api.ts packages/runtime/test/startup-environment.test.ts packages/runtime/test/tweak-api.test.ts packages/loader/test/loader.test.cjs
git commit -m "feat: apply startup environment before Claude"
```

---

### Task 4: Prepare Claude++ 0.2.4 compatibility and release metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/installer/package.json`
- Modify: `packages/loader/package.json`
- Modify: `packages/runtime/package.json`
- Modify: `packages/sdk/package.json`
- Modify: `packages/runtime/src/version.ts`
- Modify: `packages/installer/src/cli.ts`
- Modify: `packages/installer/src/commands/install.ts`
- Modify: `packages/installer/src/commands/self-update.ts`
- Modify: `packages/installer/test/commands.test.ts`
- Modify: `packages/runtime/test/update-service.test.ts`
- Modify: `scripts/package-windows.ps1`
- Modify: `scripts/test-windows-package.ps1`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/0.2.4.md`

**Interfaces:**
- Consumes: completed startup-environment API from Tasks 1–3.
- Produces: runtime/version floor `0.2.4` for the standalone Tweak.

- [ ] **Step 1: Change version assertions first and verify failure**

Change existing exact assertions from `0.2.3` to `0.2.4` in installer/runtime/package tests, but do not change
implementation constants yet.

Run:

```powershell
node --import tsx --test packages/installer/test/commands.test.ts packages/runtime/test/update-service.test.ts
```

Expected: FAIL with actual version `0.2.3`.

- [ ] **Step 2: Update every product and package version mechanically**

Set every version/path discovered by this command to `0.2.4`:

```powershell
rg -n "0\.2\.3" package.json package-lock.json packages scripts CHANGELOG.md
```

Update package archive names to `claude-plusplus-0.2.4-win-x64.zip` and staging directory to
`claude-plusplus-0.2.4-win-x64`. Use `npm install --package-lock-only` after package versions change so workspace lock
entries remain consistent.

- [ ] **Step 3: Add focused release notes**

`docs/releases/0.2.4.md` must state:

- new permission `startup-environment`;
- declarative owned-key manifest contract;
- early application before Claude's original main entry;
- baseline-safe relaunch and fail-closed snapshot behavior;
- no system environment, registry, Claude settings, or server-compaction modification;
- existing installation and `doctor` instructions consistent with 0.2.3 notes.

Add a `0.2.4` link/summary at the top of `CHANGELOG.md`.

- [ ] **Step 4: Run full tests and Windows package verification**

```powershell
npm test
npm run package:windows
pwsh -File scripts/test-windows-package.ps1
```

Expected: all tests PASS and `dist\claude-plusplus-0.2.4-win-x64.zip` passes package inspection.

- [ ] **Step 5: Commit 0.2.4 preparation without tagging or pushing**

```powershell
git add package.json package-lock.json packages scripts CHANGELOG.md docs/releases/0.2.4.md
git commit -m "release: prepare Claude++ 0.2.4"
```

Do not create `v0.2.4` or push it in this task.

---

### Task 5: Create the standalone Tweak's validated Main behavior

**Files:**
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\.gitignore`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\package.json`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\manifest.json`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\index.js`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\test\index.test.js`

**Interfaces:**
- Consumes: Claude++ `0.2.4` `api.startupEnvironment` Main API.
- Produces: `validateSettings(input): { ok, value?, errors }`.
- Produces: `toStartupEnvironmentConfig(settings): StartupEnvironmentConfig`.
- Produces Main IPC handlers: `get-settings`, `save-settings`, and `relaunch`.

- [ ] **Step 1: Initialize the independent Git repository and test shell**

Create the directory, initialize `master`, and create metadata without creating a remote:

```powershell
New-Item -ItemType Directory -Path D:\workspace\sgproj\FilePackages\gpt-context-window -Force
git init -b master D:\workspace\sgproj\FilePackages\gpt-context-window
```

`package.json`:

```json
{
  "name": "kpk-gpt-context-window",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "scripts": {
    "test": "node --test test/*.test.js scripts/compatibility/*.test.mjs"
  }
}
```

`.gitignore` contains only generated/local outputs:

```gitignore
node_modules/
coverage/
*.log
```

- [ ] **Step 2: Create the manifest and failing behavior tests**

`manifest.json` must contain:

```json
{
  "id": "com.kpk.gpt-context-window",
  "name": "GPT Context Window",
  "version": "0.1.0",
  "githubRepo": "kpkhxlgy0/gpt-context-window",
  "description": "Configure Claude Desktop client-side context and automatic-compaction thresholds.",
  "author": "KPK",
  "tags": ["gpt", "context", "compaction"],
  "minRuntime": "0.2.4",
  "scope": "both",
  "main": "index.js",
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

In `test/index.test.js`, require `../index.js` and add table-driven validation tests for:

- defaults `{ enabled: false, maxContextTokens: 272000, autoCompactWindow: 250000, autoCompactPct: 85 }`;
- `enabled` must be a boolean;
- integers only;
- max context `> 100000`;
- compact window `>= 100000` and `< maxContextTokens`;
- percentage `1..100`;
- whole-request rejection with field-keyed errors.

Also assert exact mapping to string variables:

```js
assert.deepEqual(__test.toStartupEnvironmentConfig(valid), {
  enabled: true,
  variables: {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "272000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85",
  },
});
```

- [ ] **Step 3: Run tests and verify entry-module failure**

```powershell
Set-Location D:\workspace\sgproj\FilePackages\gpt-context-window
npm test
```

Expected: FAIL because `index.js` and exported test helpers do not exist.

- [ ] **Step 4: Implement defaults, validation, mapping, and Main handlers**

`index.js` must expose these constants/functions through `__test`:

```js
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  maxContextTokens: 272000,
  autoCompactWindow: 250000,
  autoCompactPct: 85,
});

const ENVIRONMENT_KEYS = Object.freeze({
  maxContextTokens: "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  autoCompactWindow: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  autoCompactPct: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
});

function parseBase10Integer(input) {
  if (typeof input === "number") return Number.isSafeInteger(input) ? input : Number.NaN;
  if (typeof input !== "string" || !/^[0-9]+$/.test(input.trim())) return Number.NaN;
  const value = Number(input.trim());
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function validateSettings(input) {
  const value = {
    enabled: input?.enabled,
    maxContextTokens: parseBase10Integer(input?.maxContextTokens),
    autoCompactWindow: parseBase10Integer(input?.autoCompactWindow),
    autoCompactPct: parseBase10Integer(input?.autoCompactPct),
  };
  const errors = {};
  if (typeof value.enabled !== "boolean") {
    errors.enabled = "启用状态必须是布尔值。";
  }
  if (!Number.isInteger(value.maxContextTokens) || value.maxContextTokens <= 100000) {
    errors.maxContextTokens = "最大上下文 Token 必须是大于 100000 的整数。";
  }
  if (!Number.isInteger(value.autoCompactWindow) || value.autoCompactWindow < 100000) {
    errors.autoCompactWindow = "自动压缩窗口 Token 必须是不小于 100000 的整数。";
  } else if (
    Number.isInteger(value.maxContextTokens) &&
    value.autoCompactWindow >= value.maxContextTokens
  ) {
    errors.autoCompactWindow = "自动压缩窗口 Token 必须小于最大上下文 Token。";
  }
  if (!Number.isInteger(value.autoCompactPct) || value.autoCompactPct < 1 || value.autoCompactPct > 100) {
    errors.autoCompactPct = "自动压缩阈值百分比必须是 1 到 100 的整数。";
  }
  return Object.keys(errors).length === 0
    ? { ok: true, value, errors }
    : { ok: false, errors };
}

function toStartupEnvironmentConfig(settings) {
  return {
    enabled: settings.enabled,
    variables: {
      [ENVIRONMENT_KEYS.maxContextTokens]: String(settings.maxContextTokens),
      [ENVIRONMENT_KEYS.autoCompactWindow]: String(settings.autoCompactWindow),
      [ENVIRONMENT_KEYS.autoCompactPct]: String(settings.autoCompactPct),
    },
  };
}

function fromStartupEnvironmentConfig(config) {
  if (!config) return null;
  return validateSettings({
    enabled: config.enabled,
    maxContextTokens: config.variables[ENVIRONMENT_KEYS.maxContextTokens],
    autoCompactWindow: config.variables[ENVIRONMENT_KEYS.autoCompactWindow],
    autoCompactPct: config.variables[ENVIRONMENT_KEYS.autoCompactPct],
  });
}

let activeMainApi = null;

function requireActiveMainApi() {
  if (!activeMainApi) throw new Error("GPT Context Window Main lifecycle is inactive.");
  return activeMainApi;
}

function requireStartupEnvironment(api) {
  if (!api.startupEnvironment) {
    throw new Error("GPT Context Window requires Claude++ 0.2.4 or newer.");
  }
  return api.startupEnvironment;
}

function startMain(api) {
  if (!api.ipc || typeof api.ipc.handle !== "function") {
    throw new Error("GPT Context Window Main IPC is unavailable.");
  }
  activeMainApi = api;
  api.ipc.handle("get-settings", () => {
    const startupEnvironment = requireStartupEnvironment(requireActiveMainApi());
    const status = startupEnvironment.getStatus();
    const parsed = fromStartupEnvironmentConfig(status.saved);
    return {
      settings: parsed?.ok ? parsed.value : DEFAULT_SETTINGS,
      status,
    };
  });
  api.ipc.handle("save-settings", (input) => {
    const result = validateSettings(input);
    if (!result.ok) {
      const error = new Error("GPT Context Window settings are invalid.");
      error.details = result.errors;
      throw error;
    }
    const status = requireStartupEnvironment(requireActiveMainApi()).save(
      toStartupEnvironmentConfig(result.value),
    );
    return { settings: result.value, status };
  });
  api.ipc.handle("relaunch", () => requireStartupEnvironment(requireActiveMainApi()).relaunch());
}

function stopMain() {
  activeMainApi = null;
}

function start(api) {
  return api.process === "main" ? startMain(api) : null;
}

function stop() {
  stopMain();
}

module.exports = {
  start,
  stop,
  __test: {
    DEFAULT_SETTINGS,
    parseBase10Integer,
    validateSettings,
    toStartupEnvironmentConfig,
    fromStartupEnvironmentConfig,
    startMain,
    stopMain,
  },
};
```

Main handler behavior:

- `get-settings`: require `api.startupEnvironment`; return defaults if `status.saved` is null, plus `status`.
- `save-settings`: validate the entire request; throw one sanitized validation error object if invalid; call
  `api.startupEnvironment.save(toStartupEnvironmentConfig(value))`; return normalized settings plus status.
- `relaunch`: call `api.startupEnvironment.relaunch()` and return no value.
- missing API: throw `GPT Context Window requires Claude++ 0.2.4 or newer.`

Use only Tweak-namespaced `api.ipc.handle`; rely on lease disposal to unregister native handlers. `stopMain` must drop
retained references so hot reload cannot call an old lease.

- [ ] **Step 5: Add Main lifecycle tests and make them pass**

Use a fake API that records handlers and a fake startup API that records calls. Assert:

- exactly three handlers;
- `get-settings` defaults without saving;
- valid save calls startup API once;
- invalid save calls it zero times;
- relaunch calls once;
- stop followed by start uses the new API and does not retain the first one.

Run:

```powershell
npm test
```

Expected: all behavior/Main tests PASS.

- [ ] **Step 6: Commit the independent Main Tweak behavior**

```powershell
git add .gitignore package.json manifest.json index.js test/index.test.js
git commit -m "feat: configure GPT context startup environment"
```

This commit runs inside `D:\workspace\sgproj\FilePackages\gpt-context-window`, not the Claude++ repository and not
Perforce.

---

### Task 6: Add the Renderer settings page and restart UX

**Files:**
- Modify: `D:\workspace\sgproj\FilePackages\gpt-context-window\index.js`
- Modify: `D:\workspace\sgproj\FilePackages\gpt-context-window\test\index.test.js`

**Interfaces:**
- Consumes: Main handlers from Task 5 through `api.ipc.invoke`.
- Produces: settings page ID `gpt-context-window` and lifecycle `startRenderer(api)`.

- [ ] **Step 1: Add failing Renderer registration and disposal tests**

Build a minimal fake document and settings API. Assert:

```js
const lifecycle = __test.startRenderer(api, { document: fixture.document });
assert.equal(registered.id, "gpt-context-window");
assert.equal(registered.title, "GPT Context Window");
const disposeRender = registered.render(fixture.root);
assert.equal(await fixture.flush(), "loaded");
disposeRender();
lifecycle.stop();
assert.equal(unregisterCount, 1);
assert.equal(fixture.activeListenerCount(), 0);
```

- [ ] **Step 2: Add failing UI behavior tests**

Required cases:

- first load shows disabled defaults without saving;
- each input shows its environment key;
- enabling and saving sends normalized integers;
- field errors render beside only their fields and block IPC save;
- unchanged saved/applied state does not show restart actions;
- changed saved/applied state shows `重启后生效`, `稍后`, and `退出并重启 Claude`;
- `稍后` dismisses the action row but preserves the persistent restart-required status;
- restart invokes `relaunch` exactly once;
- load/save/restart IPC failures show sanitized Chinese error text;
- render disposer prevents asynchronous callbacks from changing removed UI.

Run:

```powershell
npm test
```

Expected: FAIL because no Renderer page is registered.

- [ ] **Step 3: Implement the settings page with existing Claude++ class conventions**

Use `api.settings.registerPage` and a render cleanup callback. The page content is exactly:

- switch `启用 GPT 上下文配置`;
- integer input `最大上下文 Token` with key `CLAUDE_CODE_MAX_CONTEXT_TOKENS`;
- integer input `自动压缩窗口 Token` with key `CLAUDE_CODE_AUTO_COMPACT_WINDOW`;
- integer input `自动压缩阈值百分比` with key `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`;
- one primary `保存` button;
- applied state `本次启动已应用` or `当前使用原始环境`;
- pending state `重启后生效` with `稍后` and `退出并重启 Claude`.

Keep a `disposed` flag in render scope, remove every event listener in cleanup, and unregister the page in
`startRenderer(...).stop()`. Do not store configuration in Renderer storage.

Replace Task 5's provisional Main-only export with the same process-dispatch lifecycle used by existing Claude++ Tweaks:

```js
let activeProcess = null;
let rendererLifecycle = null;

function startRenderer(api, injectedDeps = {}) {
  stopRenderer();
  const settingsHandle = api.settings
    ? api.settings.registerPage(createSettingsPage(api, injectedDeps))
    : null;
  const lifecycle = {
    stop() {
      settingsHandle?.unregister();
      if (rendererLifecycle === lifecycle) rendererLifecycle = null;
    },
  };
  rendererLifecycle = lifecycle;
  return lifecycle;
}

function stopRenderer() {
  rendererLifecycle?.stop();
}

function start(api) {
  activeProcess = api.process;
  if (api.process === "main") return startMain(api);
  if (api.process === "renderer") return startRenderer(api);
  return null;
}

function stop() {
  if (activeProcess === "main") stopMain();
  if (activeProcess === "renderer") stopRenderer();
  activeProcess = null;
}

module.exports = {
  start,
  stop,
  __test: {
    DEFAULT_SETTINGS,
    parseBase10Integer,
    validateSettings,
    toStartupEnvironmentConfig,
    fromStartupEnvironmentConfig,
    createSettingsPage,
    startMain,
    stopMain,
    startRenderer,
    stopRenderer,
  },
};
```

- [ ] **Step 4: Run tests and inspect manifest/runtime compatibility locally**

```powershell
npm test
Set-Location D:\Unity\ClaudePlusPlus
node --import tsx -e "import('./packages/sdk/src/index.ts').then(({validateTweakManifest}) => { const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('D:/workspace/sgproj/FilePackages/gpt-context-window/manifest.json','utf8')); const r=validateTweakManifest(m); if(!r.ok) throw new Error(JSON.stringify(r.errors)); })"
```

Expected: all tests PASS and manifest validation exits `0`.

- [ ] **Step 5: Commit the Renderer UI**

```powershell
Set-Location D:\workspace\sgproj\FilePackages\gpt-context-window
git add index.js test/index.test.js
git commit -m "feat: add GPT context settings page"
```

---

### Task 7: Add standalone Junction maintenance, compatibility checks, and documentation

**Files:**
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\Inject-ClaudePlusPlus.ps1`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\Uninject-ClaudePlusPlus.ps1`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\TweakLink.psm1`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\test\TweakLink.Tests.ps1`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\compatibility\validate-claudeplusplus.mjs`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\compatibility\validate-claudeplusplus.test.mjs`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\LICENSE`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\README.md`
- Create: `D:\workspace\sgproj\FilePackages\gpt-context-window\README.zh-CN.md`
- Modify: `D:\workspace\sgproj\FilePackages\gpt-context-window\package.json`

**Interfaces:**
- Consumes: source root manifest and Claude++ `0.2.4` source API.
- Produces: `Get-TweakLinkState`, `Set-TweakJunction`, and `Remove-TweakLink` PowerShell functions.
- Produces: read-only `-CheckOnly` behavior for both inject and uninject scripts.

- [ ] **Step 1: Write failing PowerShell link-safety tests**

The test script must create its own temporary `APPDATA` and cover:

- missing link -> `LinkRequired` for inject and `NotInjected` for uninject;
- current Junction -> `Current`;
- wrong-target Junction -> safely replace only the Junction;
- real directory -> `Blocked` and never remove it;
- unsupported reparse point -> `Blocked`;
- `-CheckOnly` performs no mutation;
- uninject removes only the exact Tweak Junction and preserves sibling files.

Run:

```powershell
pwsh -File scripts/test/TweakLink.Tests.ps1
```

Expected: FAIL because the module and scripts do not exist.

- [ ] **Step 2: Implement Junction-only maintenance**

Adapt the proven Unity Links/Feishu Tweak link-state pattern, with these fixed paths:

```powershell
$source = $PSScriptRoot
$linkPath = Join-Path $env:APPDATA "claude-plusplus/tweaks/com.kpk.gpt-context-window"
```

`Set-TweakJunction` may remove an existing path only when it has already classified it as a Junction. It must never
replace a real directory or unsupported reparse point. `Remove-TweakLink` has the same restriction. Before success,
verify the resolved target equals the source root and `manifest.json` exists.

- [ ] **Step 3: Write the failing source compatibility harness tests**

The harness must load Claude++ SDK/runtime source, validate the manifest, create a Main API lease with a fake startup
service, start/stop both process halves, and assert:

- runtime version is exactly `0.2.4` or newer according to `minRuntime` comparison;
- settings page registers/unregisters;
- Main registers three handlers;
- lease disposal removes all handlers;
- retained startup API references throw after disposal.

Run from the Claude++ root so `tsx` resolves:

```powershell
Set-Location D:\Unity\ClaudePlusPlus
node --import tsx --test D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\compatibility\validate-claudeplusplus.test.mjs
```

Expected before implementation: FAIL because the harness module is missing.

- [ ] **Step 4: Implement and run the compatibility harness**

Use the same source-loading pattern as Unity Links' `validate-claudeplusplus.mjs`, but check the startup-environment API
instead of Claude Sessions. The CLI form is:

```text
validate-claudeplusplus.mjs <claude-plusplus-root> <tweak-root>
```

Run:

```powershell
Set-Location D:\Unity\ClaudePlusPlus
node --import tsx D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\compatibility\validate-claudeplusplus.mjs D:\Unity\ClaudePlusPlus D:\workspace\sgproj\FilePackages\gpt-context-window
```

Expected output:

```text
claudeplusplus-compatibility=passed runtime=0.2.4 tweak=0.1.0
```

- [ ] **Step 5: Document installation, scope, and recovery**

Both READMEs must include:

- Claude++ `0.2.4+` prerequisite;
- `Inject-ClaudePlusPlus.ps1` and `Uninject-ClaudePlusPlus.ps1` commands;
- full Claude restart requirement;
- defaults and validation limits;
- process-wide effect, including provider switches;
- explicit statement that it does not modify system environment, registry, or Claude settings;
- explicit statement that CC-Switch GPT server-side compaction is not implemented;
- recovery: disable internally and restart, globally disable and restart, or uninject and restart.

Use the MIT text with `Copyright (c) 2026 KPK`.

- [ ] **Step 6: Run all standalone checks**

```powershell
Set-Location D:\workspace\sgproj\FilePackages\gpt-context-window
npm test
pwsh -File scripts/test/TweakLink.Tests.ps1
Set-Location D:\Unity\ClaudePlusPlus
node --import tsx D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\compatibility\validate-claudeplusplus.mjs D:\Unity\ClaudePlusPlus D:\workspace\sgproj\FilePackages\gpt-context-window
```

Expected: Node tests PASS, PowerShell tests PASS, and compatibility output matches the exact line above.

- [ ] **Step 7: Commit maintenance and documentation**

```powershell
Set-Location D:\workspace\sgproj\FilePackages\gpt-context-window
git add Inject-ClaudePlusPlus.ps1 Uninject-ClaudePlusPlus.ps1 scripts LICENSE README.md README.zh-CN.md package.json
git commit -m "chore: add GPT context tweak maintenance"
```

Do not create a GitHub repository or push in this task.

---

### Task 8: Package, install, and perform cross-repository acceptance

**Files:**
- Verify only; return to the owning task for any required fix.

**Interfaces:**
- Consumes: Claude++ `0.2.4` package and GPT Context Window `0.1.0` source/Junction scripts.
- Produces: recorded automated and real-app acceptance evidence.

- [ ] **Step 1: Re-run clean automated gates in both repositories**

```powershell
Set-Location D:\Unity\ClaudePlusPlus
git status --short
npm test
npm run package:windows
pwsh -File scripts/test-windows-package.ps1

Set-Location D:\workspace\sgproj\FilePackages\gpt-context-window
git status --short
npm test
pwsh -File scripts/test/TweakLink.Tests.ps1

Set-Location D:\Unity\ClaudePlusPlus
node --import tsx D:\workspace\sgproj\FilePackages\gpt-context-window\scripts\compatibility\validate-claudeplusplus.mjs D:\Unity\ClaudePlusPlus D:\workspace\sgproj\FilePackages\gpt-context-window
```

Expected: both Git worktrees contain only their intended commits, all tests PASS, package inspection PASS, and
compatibility PASS.

- [ ] **Step 2: Obtain the current-turn user confirmation that Claude Desktop is fully closed**

Do not install or replace the managed Claude++ runtime while Claude is open. State that the next action installs the
locally built `0.2.4` package and wait for the user to confirm Claude is closed.

- [ ] **Step 3: Install Claude++ 0.2.4 and verify runtime health**

Extract `dist\claude-plusplus-0.2.4-win-x64.zip` to a temporary directory, run its `install.ps1`, then run:

```powershell
claudeplusplus status
claudeplusplus doctor
```

Expected: managed Claude, Loader, Runtime, Settings, Store, config, and integrity checks report healthy; reported
Claude++ version is `0.2.4`.

- [ ] **Step 4: Inject the Tweak Junction and verify exact target**

```powershell
Set-Location D:\workspace\sgproj\FilePackages\gpt-context-window
pwsh -File .\Inject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -File .\Inject-ClaudePlusPlus.ps1
Get-Item "$env:APPDATA\claude-plusplus\tweaks\com.kpk.gpt-context-window" -Force | Format-List LinkType,Target
```

Expected: `LinkType` is `Junction` and `Target` resolves exactly to
`D:\workspace\sgproj\FilePackages\gpt-context-window`.

- [ ] **Step 5: Ask the user to open Claude and complete the settings acceptance sequence**

Observable sequence:

1. `GPT Context Window` appears under **TWEAKS**.
2. First load is disabled and prefilled with `272000 / 250000 / 85`.
3. Enable and save; page shows `重启后生效` with both restart actions.
4. Choose `稍后`; current applied state remains original.
5. Use `退出并重启 Claude`; after restart, page shows all three values under `本次启动已应用`.
6. Change values, save, restart, and confirm the applied values change only after restart.
7. Disable internally, restart, and confirm `当前使用原始环境`.
8. Repeat once with an incoming pre-existing value to prove exact restoration rather than unconditional deletion.

- [ ] **Step 6: Run the CC-Switch GPT long-session acceptance**

With CC-Switch Router `3.19.2` active and the user's GPT mapping selected, create or resume a long session and verify
Claude's client-side automatic compaction still occurs at the configured threshold. The UI, logs, and handoff must call
this **client-side automatic compaction** and must not claim GPT server-side compaction.

- [ ] **Step 7: Record completion without publishing**

Report:

- Claude++ commits and clean status;
- Tweak commits and clean status;
- automated test/package/compatibility results;
- managed runtime health;
- Junction target;
- user-confirmed settings/restart/restore and long-session observations.

Do not tag, push, publish, or add the new Tweak tree to Perforce until the user explicitly asks.
