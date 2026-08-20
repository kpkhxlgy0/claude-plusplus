# Installer Recovery Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude++ uninstall state-independent for managed mirrors, give Safe Mode a complete CLI/reload contract, and add trustworthy ASAR provenance with legacy migration.

**Architecture:** Keep the official Claude MSIX read-only and extend the existing Windows managed-mirror pipeline. Fixed-root cleanup is isolated in a Windows cleanup module, Safe Mode reuses the serialized Tweak reload watcher, and schema 2 state records ASAR raw-header SHA-256 values that gate mirror reuse and diagnostics.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner, `@electron/asar` 4.2.1, Windows filesystem/Junction semantics, existing Claude++ Installer and Runtime workspaces.

**Spec:** `docs/superpowers/specs/2026-08-20-installer-recovery-parity-design.md`

## Global Constraints

- The official Claude MSIX and every path under `WindowsApps` remain read-only.
- Destructive local cleanup is confined to resolved Claude++ roaming/local roots; no wildcard or state-derived fallback deletion is allowed.
- Watcher remains explicitly opt-in.
- Safe Mode cold start registers neither Renderer CSP compatibility nor the Claude++ Renderer preload.
- Safe Mode status performs no filesystem write; enable/disable always refresh the root marker `.claudepp-safe-mode-reload`.
- Schema 1 state remains readable and is never promoted from an already-patched ASAR.
- Schema 2 requires lowercase 64-character `originalAsarHash` and `patchedAsarHash` values.
- ASAR identity is SHA-256 of `@electron/asar.getRawHeader(...).headerString`, not a whole-file digest.
- A reused mirror without an exact trusted schema 2 patched hash is refreshed from the official package before a new baseline is recorded.
- Existing Tweak data, configuration, Watcher choice, and unknown configuration keys are preserved except under explicit `uninstall --purge`.
- Do not change Loader fail-open behavior, MCP architecture, platform scope, or add unrelated refactors.

---

### Task 1: State-independent managed-mirror cleanup

**Files:**
- Modify: `packages/installer/src/paths.ts`
- Create: `packages/installer/src/windows-cleanup.ts`
- Modify: `packages/installer/src/commands/uninstall.ts`
- Create: `packages/installer/src/cli-recovery.ts`
- Modify: `packages/installer/src/cli.ts`
- Modify: `packages/installer/test/paths.test.ts`
- Create: `packages/installer/test/windows-cleanup.test.ts`
- Modify: `packages/installer/test/commands.test.ts`
- Create: `packages/installer/test/cli-recovery.test.ts`

**Interfaces:**
- Produces: `assertClaudePlusPlusLocalPath(candidate, paths, allowRoot?) => void`
- Produces: `assertClaudePlusPlusStoreAppsPath(paths) => void`
- Produces: `assertClaudePlusPlusUninstallTargets(paths) => void`
- Produces: `cleanupWindowsManagedArtifacts(paths) => Promise<string[]>`
- Changes: `uninstallClaudePlusPlus(...) => Promise<{ warnings: string[] }>`
- Produces: `runRecoveryCli(command, args, dependencies?) => Promise<boolean>`
- Consumes: existing `assertManagedMirrorPath`, `uninstallWatcher`, `ClaudePlusPlusPaths`

- [ ] **Step 1: Write failing path-boundary and cleanup tests**

Add literal boundary cases to `paths.test.ts` and real temporary-root behavior to the new cleanup test:

```ts
import {
  assertClaudePlusPlusLocalPath,
  assertClaudePlusPlusStoreAppsPath,
  resolveClaudePlusPlusPaths,
} from "../src/paths.ts";
import { cleanupWindowsManagedArtifacts } from "../src/windows-cleanup.ts";

test("local cleanup accepts store-apps and rejects siblings outside localRoot", () => {
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    USERPROFILE: "C:\\Users\\Test",
  });
  assert.doesNotThrow(() => assertClaudePlusPlusLocalPath(paths.storeApps, paths));
  assert.doesNotThrow(() => assertClaudePlusPlusStoreAppsPath(paths));
  assert.throws(
    () => assertClaudePlusPlusLocalPath("C:\\Users\\Test\\AppData\\Local\\outside", paths),
    /outside.*local root/i,
  );
  assert.throws(
    () => assertClaudePlusPlusStoreAppsPath({ ...paths, storeApps: paths.cache }),
    /exact Claude\+\+ store-apps root/i,
  );
});

test("managed Windows cleanup removes only the fixed store-apps root", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cleanup-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      USERPROFILE: join(root, "profile"),
    });
    const outside = join(root, "outside", "sentinel.txt");
    mkdirSync(join(paths.storeApps, "Claude_orphan", "app"), { recursive: true });
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "keep");

    assert.deepEqual(await cleanupWindowsManagedArtifacts(paths), []);
    assert.equal(existsSync(paths.storeApps), false);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed cleanup rejects a substituted local child before removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cleanup-boundary-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      USERPROFILE: join(root, "profile"),
    });
    mkdirSync(paths.cache, { recursive: true });
    writeFileSync(join(paths.cache, "sentinel.txt"), "keep");
    await assert.rejects(
      cleanupWindowsManagedArtifacts({ ...paths, storeApps: paths.cache }),
      /exact Claude\+\+ store-apps root/i,
    );
    assert.equal(readFileSync(join(paths.cache, "sentinel.txt"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

The production mutations these tests catch are deletion from a state-controlled/outside path and failure to remove the dedicated fixed root.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --import tsx --test packages/installer/test/paths.test.ts packages/installer/test/windows-cleanup.test.ts
```

Expected: FAIL because the local assertion module export and Windows cleanup module do not exist.

- [ ] **Step 3: Implement the fixed-root cleanup helper**

Add the local assertion in `paths.ts` using `win32.resolve`/`win32.relative`, parallel to the roaming assertion:

```ts
export function assertClaudePlusPlusLocalPath(
  candidate: string,
  paths: ClaudePlusPlusPaths,
  allowRoot = false,
): void {
  const root = win32.resolve(paths.localRoot);
  const target = win32.resolve(candidate);
  const child = win32.relative(root, target);
  if ((!allowRoot && !child) || child.startsWith("..") || win32.isAbsolute(child)) {
    throw new Error(`Path is outside the Claude++ local root: ${candidate}`);
  }
}

export function assertClaudePlusPlusStoreAppsPath(paths: ClaudePlusPlusPaths): void {
  const expected = win32.resolve(win32.join(paths.localRoot, "store-apps"));
  const actual = win32.resolve(paths.storeApps);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Path is not the exact Claude++ store-apps root: ${paths.storeApps}`);
  }
  assertClaudePlusPlusLocalPath(paths.storeApps, paths);
}
```

Add one shared exact-path comparator and use it from `assertClaudePlusPlusUninstallTargets(paths)`. That preflight must require, case-insensitively with Windows semantics:

- `paths.runtime === win32.join(paths.roamingRoot, "runtime")`, followed by the roaming containment assertion;
- `paths.stateFile === win32.join(paths.roamingRoot, "state.json")`, followed by the roaming containment assertion;
- `paths.shortcutFile === win32.join(win32.dirname(paths.roamingRoot), "Microsoft", "Windows", "Start Menu", "Programs", "Claude++.lnk")`;
- `paths.storeApps === win32.join(paths.localRoot, "store-apps")`, through `assertClaudePlusPlusStoreAppsPath`.

Each mismatch error names the exact rejected target. Do not treat ordinary roaming containment as sufficient for Runtime: `paths.tweaks` and `paths.tweakData` are contained but must survive ordinary uninstall.

Create `windows-cleanup.ts` with a fixed target and explicit warning result:

```ts
import { rm } from "node:fs/promises";
import {
  assertClaudePlusPlusStoreAppsPath,
  type ClaudePlusPlusPaths,
} from "./paths.js";

export async function cleanupWindowsManagedArtifacts(
  paths: ClaudePlusPlusPaths,
): Promise<string[]> {
  assertClaudePlusPlusStoreAppsPath(paths);
  try {
    await rm(paths.storeApps, { recursive: true, force: true });
    return [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      `Could not remove Claude++ managed Store mirrors at ${paths.storeApps}. ` +
      `Close Claude++ and rerun uninstall. ${detail}`,
    ];
  }
}
```

- [ ] **Step 4: Run the cleanup tests and verify GREEN**

Run the same two-file Node test command. Expected: all tests PASS and the outside sentinel remains.

- [ ] **Step 5: Write failing uninstall tests for missing/malformed state and warnings**

Add these behaviors to `commands.test.ts` using the existing real fixture:

```ts
test("uninstall removes every managed mirror when state is missing", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const orphan = join(fixture.paths.storeApps, "Claude_orphan", "app");
    mkdirSync(orphan, { recursive: true });
    rmSync(fixture.paths.stateFile, { force: true });

    const result = await uninstallClaudePlusPlus(
      { paths: fixture.paths },
      { uninstallWatcher: () => {} },
    );

    assert.deepEqual(result, { warnings: [] });
    assert.equal(existsSync(fixture.paths.storeApps), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("purge removes fixed mirrors and roaming data when state JSON is malformed", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    writeFileSync(fixture.paths.stateFile, "{ malformed", "utf8");
    const outside = join(fixture.root, "outside", "sentinel.txt");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "keep", "utf8");

    const result = await uninstallClaudePlusPlus(
      { paths: fixture.paths, purge: true },
      { uninstallWatcher: () => {} },
    );

    assert.deepEqual(result, { warnings: [] });
    assert.equal(existsSync(fixture.paths.storeApps), false);
    assert.equal(existsSync(fixture.paths.roamingRoot), false);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall reports fixed-root cleanup failures and still removes runtime state", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const result = await uninstallClaudePlusPlus({ paths: fixture.paths }, {
      uninstallWatcher: () => {},
      cleanupWindowsManagedArtifacts: async (paths) => [
        `Could not remove Claude++ managed Store mirrors at ${paths.storeApps}. ` +
        "Close Claude++ and rerun uninstall. locked managed mirror",
      ],
    });
    assert.deepEqual(result.warnings, [
      `Could not remove Claude++ managed Store mirrors at ${fixture.paths.storeApps}. ` +
      "Close Claude++ and rerun uninstall. locked managed mirror",
    ]);
    assert.equal(existsSync(fixture.paths.runtime), false);
    assert.equal(existsSync(fixture.paths.stateFile), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall preflights every destructive target before Watcher cleanup", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const tweakSentinel = join(fixture.paths.tweaks, "keep.txt");
    const stateSentinel = join(fixture.root, "outside", "state-sentinel.json");
    const shortcutSentinel = join(fixture.root, "outside", "shortcut-sentinel.lnk");
    const cacheSentinel = join(fixture.paths.cache, "keep.txt");
    for (const sentinel of [tweakSentinel, stateSentinel, shortcutSentinel, cacheSentinel]) {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, "keep", "utf8");
    }
    writeFileSync(fixture.paths.stateFile, "{ malformed", "utf8");

    const substitutions = [
      {
        paths: { ...fixture.paths, runtime: fixture.paths.tweaks },
        error: /exact Claude\+\+ Runtime directory/i,
      },
      {
        paths: { ...fixture.paths, stateFile: stateSentinel },
        error: /exact Claude\+\+ state file/i,
      },
      {
        paths: { ...fixture.paths, shortcutFile: shortcutSentinel },
        error: /exact Claude\+\+ Start Menu shortcut/i,
      },
      {
        paths: { ...fixture.paths, storeApps: fixture.paths.cache },
        error: /exact Claude\+\+ store-apps root/i,
      },
    ];

    for (const substitution of substitutions) {
      let watcherCalls = 0;
      await assert.rejects(
        uninstallClaudePlusPlus(
          { paths: substitution.paths },
          { uninstallWatcher: () => { watcherCalls += 1; } },
        ),
        substitution.error,
      );
      assert.equal(watcherCalls, 0);
      for (const sentinel of [tweakSentinel, stateSentinel, shortcutSentinel, cacheSentinel]) {
        assert.equal(readFileSync(sentinel, "utf8"), "keep");
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
```

Retain the existing forged-external-state test unchanged.

- [ ] **Step 6: Run `commands.test.ts` and verify RED**

Run:

```powershell
node --import tsx --test packages/installer/test/commands.test.ts
```

Expected: FAIL because uninstall still returns `void`, lacks cleanup dependency injection, and leaves `storeApps` when state is absent.

- [ ] **Step 7: Route uninstall and CLI through the cleanup result**

Extend dependencies and return type in `uninstall.ts`:

```ts
export interface UninstallDependencies {
  uninstallWatcher(paths: ClaudePlusPlusPaths): void;
  cleanupWindowsManagedArtifacts(paths: ClaudePlusPlusPaths): Promise<string[]>;
}

export interface UninstallResult {
  warnings: string[];
}
```

Preserve the existing state-derived assertion, then call `assertClaudePlusPlusUninstallTargets(paths)` and validate optional `paths.roamingRoot` before calling `uninstallWatcher`. Every target must pass before the first mutation. Remove the one-package `rm`, call the fixed cleanup after Watcher cleanup, continue Runtime/state/shortcut cleanup, and return its warnings.

- [ ] **Step 8: Add a narrow recovery-CLI seam and failing uninstall-output test**

Create `cli-recovery.ts` without moving any unaffected command. It exports `runRecoveryCli(command, args, dependencies?)`, injected narrow `io.stdout`, `io.stderr`, and `uninstall` dependencies, and returns `false` for commands it does not own. In `cli.ts`, call it once with `command` and `argv.slice(1)` before the existing switch; return when it reports handled, remove only the old `uninstall` case, and leave install/status/debug/Doctor/repair/update aliases/Watcher/launch/version dispatch byte-for-byte unchanged.

In `cli-recovery.test.ts`:

```ts
test("uninstall propagates purge and reports residual warnings", async () => {
  const cases: Array<{ args: string[]; purged: boolean }> = [
    { args: [], purged: false },
    { args: ["--purge"], purged: true },
  ];
  for (const { args, purged } of cases) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const uninstallOptions: Array<{ purge?: boolean }> = [];
    assert.equal(await runRecoveryCli("uninstall", args, {
      io: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      uninstall: async (options) => {
        uninstallOptions.push(options);
        return { warnings: ["locked managed mirror"] };
      },
    }), true);
    assert.deepEqual(uninstallOptions, [{ purge: purged }]);
    assert.deepEqual(JSON.parse(stdout.join("\n")), {
      uninstalled: true,
      purged,
      warnings: ["locked managed mirror"],
    });
    assert.deepEqual(stderr, ["warning: locked managed mirror"]);
  }
});

test("recovery CLI declines every unaffected command", async () => {
  assert.equal(await runRecoveryCli("status", [], {
    io: { stdout: () => assert.fail("unexpected output"), stderr: () => {} },
    uninstall: async () => assert.fail("unexpected uninstall"),
  }), false);
});
```

Run the new test before implementing the dispatcher and verify RED. Then implement the dispatcher and this exact uninstall branch:

```ts
const purge = args.includes("--purge");
const uninstall = dependencies.uninstall ?? uninstallClaudePlusPlus;
const result = await uninstall({ purge });
for (const warning of result.warnings) io.stderr(`warning: ${warning}`);
io.stdout(JSON.stringify({ uninstalled: true, purged: purge, warnings: result.warnings }, null, 2));
```

- [ ] **Step 9: Run focused tests and the Installer build**

Run:

```powershell
node --import tsx --test packages/installer/test/paths.test.ts packages/installer/test/windows-cleanup.test.ts packages/installer/test/commands.test.ts packages/installer/test/cli-recovery.test.ts
npm run build --workspace @claude-plusplus/installer
```

Expected: PASS with no files created outside temporary roots.

- [ ] **Step 10: Commit Task 1**

```powershell
git add packages/installer/src/paths.ts packages/installer/src/windows-cleanup.ts packages/installer/src/commands/uninstall.ts packages/installer/src/cli-recovery.ts packages/installer/src/cli.ts packages/installer/test/paths.test.ts packages/installer/test/windows-cleanup.test.ts packages/installer/test/commands.test.ts packages/installer/test/cli-recovery.test.ts
git commit -m "fix: clean managed mirrors without installer state"
```

---

### Task 2: Safe Mode CLI, persistence, and reload marker

**Files:**
- Modify: `packages/installer/src/commands/safe-mode.ts`
- Modify: `packages/installer/src/cli-recovery.ts`
- Modify: `packages/installer/src/cli.ts`
- Modify: `packages/installer/test/commands.test.ts`
- Modify: `packages/installer/test/cli-recovery.test.ts`

**Interfaces:**
- Produces: `type SafeModeAction = "on" | "off" | "status"`
- Produces: `parseSafeModeArguments(argv: string[]) => SafeModeAction`
- Produces: `runSafeMode(action?, paths?, dependencies?) => SafeModeResult`
- Produces: `SafeModeResult { safeMode, changed, restartRequired }`

- [ ] **Step 1: Replace the old one-write test with failing command-contract tests**

Add imports for `parseSafeModeArguments` and `runSafeMode`, then cover literal parser outcomes and filesystem behavior:

```ts
test("Safe Mode arguments accept default/on/off/status and reject conflicts", () => {
  assert.equal(parseSafeModeArguments([]), "on");
  assert.equal(parseSafeModeArguments(["--on"]), "on");
  assert.equal(parseSafeModeArguments(["--off"]), "off");
  assert.equal(parseSafeModeArguments(["--status"]), "status");
  assert.throws(() => parseSafeModeArguments(["--on", "--off"]), /only one/i);
  assert.throws(() => parseSafeModeArguments(["--on", "--on"]), /duplicate/i);
  assert.throws(() => parseSafeModeArguments(["--wat"]), /unknown/i);
});

test("Safe Mode status is read-only and mutations preserve config then refresh the marker", async () => {
  const fixture = await createFixture();
  try {
    mkdirSync(dirname(fixture.paths.configFile), { recursive: true });
    writeFileSync(fixture.paths.configFile, JSON.stringify({
      claudePlusPlus: { safeMode: false, privateSetting: "keep" },
      tweaks: { "com.example.keep": { enabled: false } },
      untouched: { value: 7 },
    }));
    const before = readFileSync(fixture.paths.configFile, "utf8");

    assert.deepEqual(runSafeMode("status", fixture.paths), {
      safeMode: false,
      changed: false,
      restartRequired: false,
    });
    assert.equal(readFileSync(fixture.paths.configFile, "utf8"), before);
    assert.equal(existsSync(fixture.paths.tweaks), false);

    assert.deepEqual(runSafeMode("on", fixture.paths, { now: () => 100 }), {
      safeMode: true,
      changed: true,
      restartRequired: true,
    });
    const config = JSON.parse(readFileSync(fixture.paths.configFile, "utf8"));
    assert.equal(config.claudePlusPlus.privateSetting, "keep");
    assert.equal(config.tweaks["com.example.keep"].enabled, false);
    assert.equal(config.untouched.value, 7);
    const marker = join(fixture.paths.tweaks, ".claudepp-safe-mode-reload");
    assert.equal(readFileSync(marker, "utf8"), "100");

    assert.deepEqual(runSafeMode("on", fixture.paths, { now: () => 200 }), {
      safeMode: true,
      changed: false,
      restartRequired: true,
    });
    assert.equal(readFileSync(marker, "utf8"), "200");

    assert.deepEqual(runSafeMode("off", fixture.paths, { now: () => 300 }), {
      safeMode: false,
      changed: true,
      restartRequired: true,
    });
    assert.equal(readFileSync(marker, "utf8"), "300");
    assert.equal(
      JSON.parse(readFileSync(fixture.paths.configFile, "utf8")).claudePlusPlus.safeMode,
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Safe Mode status on a fresh profile creates nothing", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(runSafeMode("status", fixture.paths), {
      safeMode: false,
      changed: false,
      restartRequired: false,
    });
    assert.equal(existsSync(fixture.paths.configFile), false);
    assert.equal(existsSync(fixture.paths.tweaks), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI maps every Safe Mode form to the action and exact JSON result", async () => {
  for (const [args, expectedAction, result] of [
    [[], "on", { safeMode: true, changed: true, restartRequired: true }],
    [["--on"], "on", { safeMode: true, changed: false, restartRequired: true }],
    [["--off"], "off", { safeMode: false, changed: true, restartRequired: true }],
    [["--status"], "status", { safeMode: false, changed: false, restartRequired: false }],
  ] as const) {
    const stdout: string[] = [];
    const actions: SafeModeAction[] = [];
    assert.equal(await runRecoveryCli("safe-mode", [...args], {
      io: { stdout: (line) => stdout.push(line), stderr: () => {} },
      safeMode: (action) => { actions.push(action); return result; },
    }), true);
    assert.deepEqual(actions, [expectedAction]);
    assert.deepEqual(JSON.parse(stdout.join("\n")), result);
  }
});

test("CLI rejects conflicting Safe Mode flags and help explains restart behavior", async () => {
  await assert.rejects(
    runRecoveryCli("safe-mode", ["--on", "--off"], {
      io: { stdout: () => {}, stderr: () => {} },
    }),
    /only one/i,
  );
  const help = RECOVERY_HELP_TEXT;
  assert.match(help, /safe-mode \[--on\|--off\|--status\]/);
  assert.match(help, /Main Tweaks.*reload immediately/i);
  assert.match(help, /restart Claude.*Renderer/i);
});
```

- [ ] **Step 2: Run command and recovery-CLI tests and verify RED**

```powershell
node --import tsx --test packages/installer/test/commands.test.ts packages/installer/test/cli-recovery.test.ts
```

Expected: FAIL because the new parser/result/marker behavior and Safe Mode recovery-CLI branch do not exist.

- [ ] **Step 3: Implement Safe Mode command behavior**

Use an injectable clock to make marker tests deterministic:

```ts
export interface SafeModeDependencies {
  now(): number;
}

export interface SafeModeResult {
  safeMode: boolean;
  changed: boolean;
  restartRequired: boolean;
}

export function runSafeMode(
  action: SafeModeAction = "on",
  paths: ClaudePlusPlusPaths = resolveClaudePlusPlusPaths(),
  dependencies: Partial<SafeModeDependencies> = {},
): SafeModeResult {
  const config = readConfig(paths.configFile);
  const current = config.claudePlusPlus?.safeMode === true;
  if (action === "status") {
    return { safeMode: current, changed: false, restartRequired: false };
  }
  const enabled = action === "on";
  config.claudePlusPlus = { ...config.claudePlusPlus, safeMode: enabled };
  writeJsonAtomic(paths.configFile, config);
  mkdirSync(paths.tweaks, { recursive: true });
  writeFileSync(
    join(paths.tweaks, ".claudepp-safe-mode-reload"),
    String((dependencies.now ?? Date.now)()),
    "utf8",
  );
  return { safeMode: enabled, changed: current !== enabled, restartRequired: true };
}
```

Implement `parseSafeModeArguments` with a seen-action set so duplicate and conflicting actions have distinct errors. Update CLI dispatch and help to use the parser and describe all flags plus restart semantics.

In `cli-recovery.ts`, add an injectable `safeMode(action)` dependency, map the supplied `args` through `parseSafeModeArguments`, and write the returned `SafeModeResult` unchanged to `io.stdout`. Add exported `RECOVERY_HELP_TEXT` containing the Safe Mode command shape/restart guidance and uninstall line; interpolate that constant into the existing `cli.ts` help so the tested string is the displayed string.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run `commands.test.ts` and `cli-recovery.test.ts`. Expected: all Safe Mode tests PASS, including no-write status, repeat-marker refresh, command-argument JSON, conflict errors, and restart help.

- [ ] **Step 5: Run the Installer build**

```powershell
npm run build --workspace @claude-plusplus/installer
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 6: Commit Task 2**

```powershell
git add packages/installer/src/commands/safe-mode.ts packages/installer/src/cli-recovery.ts packages/installer/src/cli.ts packages/installer/test/commands.test.ts packages/installer/test/cli-recovery.test.ts
git commit -m "feat: complete Safe Mode CLI lifecycle"
```

---

### Task 3: Safe Mode Runtime cold-start parity

**Files:**
- Modify: `packages/runtime/src/main.ts`
- Modify: `packages/runtime/test/main.test.ts`
- Modify: `packages/runtime/test/tweak-manager.test.ts`

**Interfaces:**
- Changes: Safe Mode bootstrap does not call `registerPreloadScript`
- Relies on: Task 2 writes `.claudepp-safe-mode-reload` under the already-watched Tweak root
- Extends: the existing `TweakManager` test to name `.claudepp-safe-mode-reload` as a non-ignored root event

- [ ] **Step 1: Change the existing Safe Mode test to the approved failing expectation**

Rename the existing test and change its assertions:

```ts
test("Safe Mode cold start keeps management IPC but registers no Renderer preload", async () => {
  let sessionCreated: ((session: Record<string, unknown>) => void) | undefined;
  const electron = fakeElectron(
    fakeSession(
      () => { registrationCount += 1; return "default-safe-mode"; },
      () => { cspHookCount += 1; },
    ),
    (listener) => { sessionCreated = listener; },
    undefined,
    (channel, handler) => handlers.set(channel, handler),
    undefined,
    (listener) => { willQuit = listener; },
  );
  await bootstrapRuntime({
    electron,
    userRoot: root,
    preloadPath: "C:\\runtime\\preload.js",
    startupEnvironment: startupEnvironment(root),
    claudeCodeSettings: codeSettings(root),
    desktopMcpService,
  });
  assert.ok(sessionCreated);
  sessionCreated?.(fakeSession(
    () => { registrationCount += 1; return "late-safe-mode"; },
    () => { cspHookCount += 1; },
  ));
  const payload = await handlers.get("claudepp:list-tweaks")?.({}) as Array<{ enabled: boolean }>;
  assert.equal(registrationCount, 0);
  assert.equal(cspHookCount, 0);
  assert.equal(handlers.has("claudepp:list-tweaks"), true);
  assert.deepEqual(payload.map((item) => item.enabled), [false]);
});
```

Extend it with a captured `session-created` listener, invoke that listener with a second fake Session, and assert its preload/CSP counters also remain zero.

In the existing `filesystem changes debounce to one reload and ignore node_modules` test, replace its second accepted event with the actual root marker:

```ts
allListener?.("change", "D:\\tweaks\\com.example.one\\index.js");
allListener?.("change", "D:\\tweaks\\.claudepp-safe-mode-reload");
if (!ignored?.("D:\\tweaks\\com.example.one\\node_modules\\pkg\\index.js")) {
  allListener?.("change", "D:\\tweaks\\com.example.one\\node_modules\\pkg\\index.js");
}
assert.deepEqual(delays, [250, 250]);
```

This is a characterization assertion for the already-existing generic root watcher; the cold-start expectation remains the RED behavior for this task.

- [ ] **Step 2: Run the Runtime bootstrap and watcher tests and verify RED**

```powershell
node --import tsx --test packages/runtime/test/main.test.ts packages/runtime/test/tweak-manager.test.ts
```

Expected: `main.test.ts` FAILS because the default Session still registers one preload in Safe Mode; `tweak-manager.test.ts` remains GREEN and proves the Task 2 marker enters the serialized lifecycle.

- [ ] **Step 3: Gate preload registration at cold start**

Change the Session registration closure in `main.ts`:

```ts
const register = (session: Electron.Session) => {
  if (registeredSessions.has(session)) return;
  registeredSessions.add(session);
  if (safeMode) return;
  installRendererTweakCspCompatibility(session, log);
  registerPreload(session, deps.preloadPath, log);
};
```

Do not remove management IPC, the main Tweak watcher, startup-environment Safe Mode checks, or shutdown cleanup.

- [ ] **Step 4: Run Runtime tests and verify GREEN**

Run:

```powershell
node --import tsx --test packages/runtime/test/main.test.ts packages/runtime/test/tweak-manager.test.ts
```

Expected: PASS with default and later Session registration counts both zero in cold-start Safe Mode, while the existing generic root-change lifecycle tests remain green.

- [ ] **Step 5: Run the Runtime build**

```powershell
npm run build --workspace @claude-plusplus/runtime
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 6: Commit Task 3**

```powershell
git add packages/runtime/src/main.ts packages/runtime/test/main.test.ts packages/runtime/test/tweak-manager.test.ts
git commit -m "fix: omit Renderer preload in Safe Mode"
```

---

### Task 4: ASAR header identity and schema 2 state

**Files:**
- Modify: `packages/installer/src/asar.ts`
- Modify: `packages/installer/src/state.ts`
- Modify: `packages/installer/test/asar.test.ts`
- Create: `packages/installer/test/state.test.ts`

**Interfaces:**
- Produces: `readAsarHeaderHash(asarPath: string) => string`
- Produces: `ClaudePlusPlusStateV1`, `ClaudePlusPlusStateV2`, union `ClaudePlusPlusState`
- Produces: `isClaudePlusPlusStateV2(state) => state is ClaudePlusPlusStateV2`
- Preserves: schema 1 strict reader compatibility and atomic state writes

- [ ] **Step 1: Write a failing raw-header hash test**

Extend the existing real ASAR fixture test:

```ts
import { createHash } from "node:crypto";
import { injectClaudePlusPlusLoader, inspectClaudePlusPlusLoader, readAsarHeaderHash } from "../src/asar.ts";

const raw = (asar as unknown as {
  getRawHeader(path: string): { headerString: string };
}).getRawHeader(asarPath);
const expected = createHash("sha256").update(raw.headerString).digest("hex");
assert.equal(readAsarHeaderHash(asarPath), expected);
assert.match(expected, /^[0-9a-f]{64}$/);
```

The production mutations caught are hashing the full file, using the wrong algorithm, or returning a non-normalized digest.

- [ ] **Step 2: Write failing schema reader tests**

Create `state.test.ts` with literal schema fixtures:

```ts
const base = {
  claudePlusPlusVersion: "0.2.9",
  packageFullName: "Claude_fixture_x64__test",
  packageVersion: "1.0.0.0",
  officialAppRoot: "C:\\official\\app",
  managedAppRoot: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app",
  managedExecutable: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app\\claude.exe",
  asarPath: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app\\resources\\app.asar",
  originalMain: ".vite/build/index.pre.js",
  installedAt: "2026-08-20T00:00:00.000Z",
  watcher: "scheduled-task" as const,
};

test("state reader accepts schema 1 and strict schema 2 hashes", () => {
  withStateFile({ schemaVersion: 1, ...base }, (file) => {
    const state = readClaudePlusPlusState(file);
    assert.equal(state?.schemaVersion, 1);
    assert.equal(isClaudePlusPlusStateV2(state), false);
  });
  withStateFile({
    schemaVersion: 2,
    ...base,
    originalAsarHash: "1".repeat(64),
    patchedAsarHash: "a".repeat(64),
  }, (file) => {
    const state = readClaudePlusPlusState(file);
    assert.equal(state?.schemaVersion, 2);
    assert.equal(isClaudePlusPlusStateV2(state), true);
  });
});

test("state reader rejects malformed schema 2 hashes", () => {
  withStateFile({
    schemaVersion: 2,
    ...base,
    originalAsarHash: "ABC",
    patchedAsarHash: "a".repeat(64),
  }, (file) => assert.equal(readClaudePlusPlusState(file), null));
});

for (const field of ["originalAsarHash", "patchedAsarHash"] as const) {
  for (const invalid of [
    undefined,
    7,
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
  ]) {
    test(`state reader rejects ${field} value ${String(invalid)}`, () => {
      const value: Record<string, unknown> = {
        schemaVersion: 2,
        ...base,
        originalAsarHash: "1".repeat(64),
        patchedAsarHash: "a".repeat(64),
      };
      if (invalid === undefined) delete value[field];
      else value[field] = invalid;
      withStateFile(value, (file) => assert.equal(readClaudePlusPlusState(file), null));
    });
  }
}

for (const field of [
  "claudePlusPlusVersion",
  "packageFullName",
  "packageVersion",
  "officialAppRoot",
  "managedAppRoot",
  "managedExecutable",
  "asarPath",
  "originalMain",
  "installedAt",
] as const) {
  test(`state reader requires common field ${field}`, () => {
    const value: Record<string, unknown> = { schemaVersion: 1, ...base };
    delete value[field];
    withStateFile(value, (file) => assert.equal(readClaudePlusPlusState(file), null));
  });
}

test("state reader rejects unsupported schemas and normalizes Watcher", () => {
  withStateFile({ schemaVersion: 3, ...base }, (file) => {
    assert.equal(readClaudePlusPlusState(file), null);
  });
  withStateFile({ schemaVersion: 1, ...base, watcher: "unexpected" }, (file) => {
    assert.equal(readClaudePlusPlusState(file)?.watcher, "none");
  });
  const { watcher: _watcher, ...withoutWatcher } = base;
  withStateFile({ schemaVersion: 1, ...withoutWatcher }, (file) => {
    assert.equal(readClaudePlusPlusState(file)?.watcher, "none");
  });
});

function withStateFile(
  value: unknown,
  assertion: (file: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-state-"));
  try {
    const file = join(root, "state.json");
    writeFileSync(file, JSON.stringify(value), "utf8");
    assertion(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Run ASAR/state tests and verify RED**

```powershell
node --import tsx --test packages/installer/test/asar.test.ts packages/installer/test/state.test.ts
```

Expected: FAIL because the hash and schema 2 interfaces do not exist.

- [ ] **Step 4: Implement the raw-header helper**

In `asar.ts`, import `createHash`, clear the ASAR cache, read `headerString`, and return:

```ts
export function readAsarHeaderHash(asarPath: string): string {
  clearAsarCache(asarPath);
  const raw = (asar as unknown as {
    getRawHeader(path: string): { headerString: string };
  }).getRawHeader(asarPath);
  return createHash("sha256").update(raw.headerString).digest("hex");
}
```

- [ ] **Step 5: Implement the state union and strict reader**

Extract common fields, define schema-specific types, and validate hashes with `/^[0-9a-f]{64}$/` only for schema 2:

```ts
interface ClaudePlusPlusStateBase {
  claudePlusPlusVersion: string;
  packageFullName: string;
  packageVersion: string;
  officialAppRoot: string;
  managedAppRoot: string;
  managedExecutable: string;
  asarPath: string;
  originalMain: string;
  installedAt: string;
  watcher?: "scheduled-task" | "none";
}

export interface ClaudePlusPlusStateV1 extends ClaudePlusPlusStateBase {
  schemaVersion: 1;
}

export interface ClaudePlusPlusStateV2 extends ClaudePlusPlusStateBase {
  schemaVersion: 2;
  originalAsarHash: string;
  patchedAsarHash: string;
}

export type ClaudePlusPlusState = ClaudePlusPlusStateV1 | ClaudePlusPlusStateV2;

export function isClaudePlusPlusStateV2(
  state: ClaudePlusPlusState | null,
): state is ClaudePlusPlusStateV2 {
  return state?.schemaVersion === 2;
}
```

Do not cast an arbitrary parsed object directly to the union before all common and schema-specific fields pass.

- [ ] **Step 6: Run ASAR/state tests and verify GREEN**

Run the focused two-file test command. Expected: PASS for schema 1, schema 2, invalid hashes, and the real header digest.

- [ ] **Step 7: Run the Installer build**

```powershell
npm run build --workspace @claude-plusplus/installer
```

Expected: exit 0 with the state union narrowed without unsafe casts.

- [ ] **Step 8: Commit Task 4**

```powershell
git add packages/installer/src/asar.ts packages/installer/src/state.ts packages/installer/test/asar.test.ts packages/installer/test/state.test.ts
git commit -m "feat: record versioned ASAR provenance state"
```

---

### Task 5: Trusted mirror refresh and state migration

**Files:**
- Modify: `packages/installer/src/windows-store-mirror.ts`
- Modify: `packages/installer/src/commands/install.ts`
- Modify: `packages/installer/test/windows-store-mirror.test.ts`
- Modify: `packages/installer/test/commands.test.ts`

**Interfaces:**
- Changes: `MirrorFileSystem` gains optional `forceRefresh?: boolean`
- Changes: `InstallCommandDeps` gains optional injectable `mirrorFileSystem?: MirrorFileSystem`
- Consumes: `readAsarHeaderHash`, `isClaudePlusPlusStateV2`
- Produces: every successful new/repair install writes schema 2
- Preserves: exact schema 2 patched same-version maintenance does not recopy the mirror

- [ ] **Step 1: Write a failing forced-refresh mirror test**

In `windows-store-mirror.test.ts`:

```ts
test("force refresh replaces a current marked mirror from the official source", async () => {
  const fixture = createFixture();
  try {
    const first = await ensureWindowsStoreMirror(fixture.install, fixture.paths);
    writeFileSync(join(first.appRoot, "managed-only.txt"), "remove");
    writeFileSync(join(fixture.source, "official-new.txt"), "copy");

    const second = await ensureWindowsStoreMirror(
      fixture.install,
      fixture.paths,
      { forceRefresh: true },
    );

    assert.equal(second.reused, false);
    assert.equal(existsSync(join(second.appRoot, "managed-only.txt")), false);
    assert.equal(readFileSync(join(second.appRoot, "official-new.txt"), "utf8"), "copy");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed force refresh restores the current mirror", async () => {
  const fixture = createFixture();
  try {
    const first = await ensureWindowsStoreMirror(fixture.install, fixture.paths);
    writeFileSync(join(first.appRoot, "sentinel.txt"), "old");
    writeFileSync(join(fixture.source, "sentinel.txt"), "new");
    const fileSystem: MirrorFileSystem = {
      forceRefresh: true,
      rename: async (source, target) => {
        if (source.includes(".staging-") && target === first.appRoot) {
          throw new Error("simulated force-refresh failure");
        }
        renameSync(source, target);
      },
    };

    await assert.rejects(
      ensureWindowsStoreMirror(fixture.install, fixture.paths, fileSystem),
      /simulated force-refresh failure/,
    );
    assert.equal(readFileSync(join(first.appRoot, "sentinel.txt"), "utf8"), "old");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write failing install/migration/drift tests**

Update the primary install test to assert schema 2 and exact on-disk hash:

```ts
assert.equal(state.schemaVersion, 2);
if (state.schemaVersion !== 2) assert.fail("expected schema 2 state");
assert.match(state.originalAsarHash, /^[0-9a-f]{64}$/);
assert.match(state.patchedAsarHash, /^[0-9a-f]{64}$/);
assert.notEqual(state.originalAsarHash, state.patchedAsarHash);
assert.equal(readAsarHeaderHash(state.asarPath), state.patchedAsarHash);
```

Add these real behaviors:

```ts
test("maintenance rebuilds a legacy reused mirror before migrating to schema 2", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const current = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(current && current.schemaVersion === 2);
    const { originalAsarHash: _original, patchedAsarHash: _patched, ...common } = current;
    writeFileSync(fixture.paths.stateFile, JSON.stringify({ ...common, schemaVersion: 1 }));
    writeFileSync(join(current.managedAppRoot, "managed-only.txt"), "remove");

    const result = await installClaudePlusPlus(fixture.options, fixture.deps);
    const migrated = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.equal(result.status, "installed");
    assert.equal(migrated?.schemaVersion, 2);
    assert.equal(existsSync(join(current.managedAppRoot, "managed-only.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "original ASAR",
    mutate: async (fixture, state) => copyFileSync(fixture.install.asarPath, state.asarPath),
  },
  {
    name: "drifted ASAR",
    mutate: async (fixture, state) => writeReplacementAsar(state.asarPath, fixture.root),
  },
  {
    name: "unreadable ASAR",
    mutate: async (_fixture, state) => writeFileSync(state.asarPath, "not an asar"),
  },
  {
    name: "missing state",
    mutate: async (fixture, _state) => rmSync(fixture.paths.stateFile, { force: true }),
  },
  {
    name: "malformed state",
    mutate: async (fixture, _state) => writeFileSync(fixture.paths.stateFile, "{ malformed"),
  },
  {
    name: "mismatched schema 2 package identity",
    mutate: async (fixture, state) => writeFileSync(
      fixture.paths.stateFile,
      JSON.stringify({ ...state, packageVersion: "9.9.9.9" }),
    ),
  },
] satisfies Array<{
  name: string;
  mutate(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    state: ClaudePlusPlusStateV2,
  ): Promise<unknown>;
}>) {
  test(`maintenance cleanly refreshes a reused mirror with ${scenario.name}`, async () => {
    const fixture = await createFixture();
    try {
      await installClaudePlusPlus(fixture.options, fixture.deps);
      const state = readClaudePlusPlusState(fixture.paths.stateFile);
      assert.ok(state?.schemaVersion === 2);
      writeFileSync(join(state.managedAppRoot, "managed-only.txt"), "remove");
      await scenario.mutate(fixture, state);

      const result = await installClaudePlusPlus(fixture.options, fixture.deps);
      const repaired = readClaudePlusPlusState(fixture.paths.stateFile);
      assert.equal(result.status, "installed");
      assert.ok(repaired?.schemaVersion === 2);
      assert.equal(repaired.originalAsarHash, readAsarHeaderHash(fixture.install.asarPath));
      assert.equal(readAsarHeaderHash(repaired.asarPath), repaired.patchedAsarHash);
      assert.notEqual(repaired.originalAsarHash, repaired.patchedAsarHash);
      assert.equal(existsSync(join(state.managedAppRoot, "managed-only.txt")), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("failed forced install refresh restores the mirror and preserves state byte-for-byte", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state?.schemaVersion === 2);
    const stateBefore = readFileSync(fixture.paths.stateFile);
    writeFileSync(join(state.managedAppRoot, "sentinel.txt"), "old");
    const mirrorFileSystem: MirrorFileSystem = {
      rename: async (source, target) => {
        if (source.includes(".staging-") && target === state.managedAppRoot) {
          throw new Error("simulated install refresh failure");
        }
        renameSync(source, target);
      },
    };

    await assert.rejects(
      installClaudePlusPlus(
        { ...fixture.options, force: true },
        { ...fixture.deps, mirrorFileSystem },
      ),
      /simulated install refresh failure/,
    );
    assert.deepEqual(readFileSync(fixture.paths.stateFile), stateBefore);
    assert.equal(readFileSync(join(state.managedAppRoot, "sentinel.txt"), "utf8"), "old");
    assert.equal(readAsarHeaderHash(state.asarPath), state.patchedAsarHash);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function writeReplacementAsar(target: string, root: string): Promise<void> {
  const source = join(root, "replacement-asar-source");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "replacement", main: "index.js" }),
  );
  writeFileSync(join(source, "index.js"), "module.exports = 'replacement';\n");
  rmSync(target, { force: true });
  await asar.createPackage(source, target);
}
```

Retain the existing current-install test asserting `managed-only.txt` stays when schema 2 and the patched hash are exact.

- [ ] **Step 3: Run mirror/command tests and verify RED**

```powershell
node --import tsx --test packages/installer/test/windows-store-mirror.test.ts packages/installer/test/commands.test.ts
```

Expected: FAIL because force refresh is ignored and installs still write schema 1 without hash gating.

- [ ] **Step 4: Add force refresh to the atomic mirror path**

Extend the existing dependency object rather than adding a positional boolean:

```ts
export interface MirrorFileSystem {
  rename?(source: string, target: string): Promise<void>;
  forceRefresh?: boolean;
}

// In ensureWindowsStoreMirror:
if (!fileSystem.forceRefresh && await isCurrentMirror(target, install)) {
  return resultFor(target, true);
}
```

The remaining staging/backup/rollback logic stays unchanged and therefore covers forced replacement.

- [ ] **Step 5: Implement trust gating and schema 2 persistence**

In `install.ts`, read state before deciding whether a reused mirror is trusted. Read `dependencies.mirrorFileSystem ?? {}` once, pass it to the first `ensureWindowsStoreMirror` call, and pass `{ ...mirrorFileSystem, forceRefresh: true }` to a forced refresh so rollback tests exercise the real mirror pipeline. After the first mirror call, read the current header safely and compute:

```ts
function trustedPatchedState(
  state: ClaudePlusPlusState | null,
  official: ClaudeInstall,
  mirror: ManagedMirrorResult,
  currentHash: string | null,
): ClaudePlusPlusStateV2 | null {
  return mirror.reused &&
    isClaudePlusPlusStateV2(state) &&
    state.packageFullName === official.packageFullName &&
    state.packageVersion === official.packageVersion &&
    currentHash === state.patchedAsarHash
    ? state
    : null;
}
```

Use this flow:

```ts
const existingState = readClaudePlusPlusState(paths.stateFile);
const mirrorFileSystem = dependencies.mirrorFileSystem ?? {};
let mirror = await ensureWindowsStoreMirror(official, paths, mirrorFileSystem);
let currentHash = safeReadAsarHeaderHash(mirror.asarPath);
let trustedState = trustedPatchedState(existingState, official, mirror, currentHash);

if (mirror.reused && (options.force || trustedState === null)) {
  mirror = await ensureWindowsStoreMirror(official, paths, {
    ...mirrorFileSystem,
    forceRefresh: true,
  });
  currentHash = readAsarHeaderHash(mirror.asarPath);
  trustedState = null;
}

const originalAsarHash = trustedState
  ? trustedState.originalAsarHash
  : readAsarHeaderHash(mirror.asarPath);
```

Require `trustedState !== null` in the `isCurrent` expression. Read `existingState` before the first mirror call. After Loader injection, compute `patchedAsarHash`, write `schemaVersion: 2`, and preserve `existingState?.watcher ?? "none"`. If injection fails, do not write state.

For a trusted schema 2 mirror that needs only Runtime/Loader maintenance without forced refresh, preserve `existingState.originalAsarHash`. For any untrusted reused mirror, refresh before injection; never baseline its current patched bytes as original.

- [ ] **Step 6: Run mirror/command tests and verify GREEN**

Run the focused two-file command. Expected: PASS for fresh schema 2 install, exact reuse, forced repair, legacy migration, original/drift refresh, and rollback.

- [ ] **Step 7: Run Installer build**

```powershell
npm run build --workspace @claude-plusplus/installer
```

Expected: exit 0; all schema union accesses are properly narrowed.

- [ ] **Step 8: Commit Task 5**

```powershell
git add packages/installer/src/windows-store-mirror.ts packages/installer/src/commands/install.ts packages/installer/test/windows-store-mirror.test.ts packages/installer/test/commands.test.ts
git commit -m "fix: rebuild untrusted managed ASAR mirrors"
```

---

### Task 6: Status and Doctor ASAR provenance

**Files:**
- Modify: `packages/installer/src/commands/status.ts`
- Modify: `packages/installer/src/commands/doctor.ts`
- Modify: `packages/installer/test/commands.test.ts`

**Interfaces:**
- Produces: `type AsarProvenance = "patched" | "original" | "drift" | "unreadable" | "legacy"`
- Produces: `classifyAsarProvenance(state, currentHash) => AsarProvenance | null`
- Changes: `ClaudePlusPlusStatus` gains `asarProvenance`
- Changes: Doctor adds `asar-hash` immediately after `loader`

- [ ] **Step 1: Write failing pure classification and status tests**

Add literal classification assertions:

```ts
test("ASAR provenance classifies schema 2 hashes and legacy state", () => {
  const v2 = stateFixture({
    schemaVersion: 2,
    originalAsarHash: "1".repeat(64),
    patchedAsarHash: "2".repeat(64),
  });
  assert.equal(classifyAsarProvenance(v2, "2".repeat(64)), "patched");
  assert.equal(classifyAsarProvenance(v2, "1".repeat(64)), "original");
  assert.equal(classifyAsarProvenance(v2, "3".repeat(64)), "drift");
  assert.equal(classifyAsarProvenance(v2, null), "unreadable");
  assert.equal(classifyAsarProvenance(stateFixture({ schemaVersion: 1 }), null), "legacy");
  assert.equal(classifyAsarProvenance(null, null), null);
});

function stateFixture(
  state: { schemaVersion: 1 } | {
    schemaVersion: 2;
    originalAsarHash: string;
    patchedAsarHash: string;
  },
): ClaudePlusPlusState {
  return {
    ...state,
    claudePlusPlusVersion: "0.2.9",
    packageFullName: "Claude_fixture_x64__test",
    packageVersion: "1.0.0.0",
    officialAppRoot: "C:\\official\\app",
    managedAppRoot: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app",
    managedExecutable: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app\\claude.exe",
    asarPath: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app\\resources\\app.asar",
    originalMain: ".vite/build/index.pre.js",
    installedAt: "2026-08-20T00:00:00.000Z",
    watcher: "none",
  };
}
```

Extend the installed fixture assertion:

```ts
assert.equal(status.asarProvenance, "patched");
assert.equal(status.installed, true);
assert.deepEqual(doctor.checks.find((check) => check.name === "asar-hash"), {
  name: "asar-hash",
  ok: true,
  detail: "matches patched",
});
```

- [ ] **Step 2: Write failing real original/drift/unreadable/legacy tests**

Use the real command fixture and real ASAR files:

```ts
test("status and Doctor distinguish original, drifted, unreadable, and legacy ASARs", async () => {
  const fixture = await createFixture();
  try {
    await installClaudePlusPlus(fixture.options, fixture.deps);
    const state = readClaudePlusPlusState(fixture.paths.stateFile);
    assert.ok(state?.schemaVersion === 2);

    const { originalAsarHash: _original, patchedAsarHash: _patched, ...common } = state;
    writeFileSync(fixture.paths.stateFile, JSON.stringify({ ...common, schemaVersion: 1 }));
    assert.equal(getClaudePlusPlusStatus(fixture.paths).asarProvenance, "legacy");
    assert.equal(getClaudePlusPlusStatus(fixture.paths).installed, true);
    assert.deepEqual(
      (await doctorClaudePlusPlus(fixture.paths, fixture.deps)).checks.find(
        (check) => check.name === "asar-hash",
      ),
      {
        name: "asar-hash",
        ok: true,
        detail: "not recorded; run repair to establish provenance",
      },
    );
    writeFileSync(fixture.paths.stateFile, JSON.stringify(state));

    copyFileSync(fixture.install.asarPath, state.asarPath);
    assert.equal(getClaudePlusPlusStatus(fixture.paths).asarProvenance, "original");
    assert.equal(getClaudePlusPlusStatus(fixture.paths).installed, false);
    assert.deepEqual(
      (await doctorClaudePlusPlus(fixture.paths, fixture.deps)).checks.find(
        (check) => check.name === "asar-hash",
      ),
      { name: "asar-hash", ok: false, detail: "matches original; run repair" },
    );

    await writeReplacementAsar(state.asarPath, fixture.root);
    assert.equal(getClaudePlusPlusStatus(fixture.paths).asarProvenance, "drift");
    assert.deepEqual(
      (await doctorClaudePlusPlus(fixture.paths, fixture.deps)).checks.find(
        (check) => check.name === "asar-hash",
      ),
      { name: "asar-hash", ok: false, detail: "drift from original and patched" },
    );

    writeFileSync(state.asarPath, "not an asar");
    assert.equal(getClaudePlusPlusStatus(fixture.paths).asarProvenance, "unreadable");
    assert.deepEqual(
      (await doctorClaudePlusPlus(fixture.paths, fixture.deps)).checks.find(
        (check) => check.name === "asar-hash",
      ),
      { name: "asar-hash", ok: false, detail: "missing or unreadable" },
    );

    rmSync(fixture.paths.stateFile, { force: true });
    assert.equal(getClaudePlusPlusStatus(fixture.paths).asarProvenance, null);
    assert.deepEqual(
      (await doctorClaudePlusPlus(fixture.paths, fixture.deps)).checks.find(
        (check) => check.name === "asar-hash",
      ),
      { name: "asar-hash", ok: false, detail: "unavailable" },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run `commands.test.ts` and verify RED**

Expected: FAIL because provenance and Doctor's hash check do not exist.

- [ ] **Step 4: Implement classification and installed gating**

In `status.ts`:

```ts
export type AsarProvenance = "patched" | "original" | "drift" | "unreadable" | "legacy";

export function classifyAsarProvenance(
  state: ClaudePlusPlusState | null,
  currentHash: string | null,
): AsarProvenance | null {
  if (!state) return null;
  if (!isClaudePlusPlusStateV2(state)) return "legacy";
  if (currentHash === null) return "unreadable";
  if (currentHash === state.patchedAsarHash) return "patched";
  if (currentHash === state.originalAsarHash) return "original";
  return "drift";
}
```

Read the header through a narrow try/catch. `installed` retains legacy compatibility but requires `patched` for schema 2:

```ts
const provenanceReady = state?.schemaVersion === 1 || asarProvenance === "patched";
installed: Boolean(
  state && provenanceReady && existsSync(state.managedExecutable) &&
  runtimeReady && loaderReady && integrityFuseReady,
),
```

- [ ] **Step 5: Add the Doctor hash check**

Map classifications exactly:

```ts
function asarHashCheck(provenance: AsarProvenance | null): DoctorCheck {
  switch (provenance) {
    case "patched": return { name: "asar-hash", ok: true, detail: "matches patched" };
    case "legacy": return {
      name: "asar-hash",
      ok: true,
      detail: "not recorded; run repair to establish provenance",
    };
    case "original": return { name: "asar-hash", ok: false, detail: "matches original; run repair" };
    case "drift": return { name: "asar-hash", ok: false, detail: "drift from original and patched" };
    case "unreadable": return { name: "asar-hash", ok: false, detail: "missing or unreadable" };
    default: return { name: "asar-hash", ok: false, detail: "unavailable" };
  }
}
```

Insert it immediately after Loader and keep fuse/Loader checks independent.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run `commands.test.ts`. Expected: PASS for all five classifications and updated Doctor check ordering.

- [ ] **Step 7: Run complete verification**

Run separately:

```powershell
npm run build
```

```powershell
npm test
```

Expected: both exit 0; the Node test summary reports zero failures, skips, todos, or cancellations.

- [ ] **Step 8: Inspect scope and safety before commit**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Confirm only files named by this plan changed, no release ZIP/build staging files are tracked, and no test touched the live `%APPDATA%`/`%LOCALAPPDATA%` Claude++ roots.

- [ ] **Step 9: Commit Task 6**

```powershell
git add packages/installer/src/commands/status.ts packages/installer/src/commands/doctor.ts packages/installer/test/commands.test.ts
git commit -m "feat: diagnose managed ASAR provenance"
```
