# Tweak Developer Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete Claude++ Tweak authoring workflow: scaffold, validate, create a safe Windows development Junction, watch and hot-reload, and ship the workflow in the portable release with accurate documentation.

**Architecture:** The Installer consumes the existing strict `@claude-plusplus/sdk` validator through one shared project-inspection module. Thin command modules own scaffolding and reporting, a containment-checked link helper owns Windows Junction mutations, and an injected 100 ms source watcher writes a root-level marker consumed by the existing Runtime watcher. The Runtime lifecycle itself is unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner, Node `fs.watch`, Windows Junctions, existing Claude++ SDK/Installer workspaces, PowerShell portable packaging.

**Spec:** `docs/superpowers/specs/2026-08-20-tweak-developer-workflow-design.md`

## Global Constraints

- Inspect and preserve the installed Codex++ `create-tweak`, `validate-tweak`, and `dev` command shapes, while retaining every approved Claude++ difference in the spec.
- Use `@claude-plusplus/sdk.validateTweakManifest` as the only manifest validator; do not copy validation rules into the Installer.
- Create/validate/dev never execute Tweak source.
- Every accepted explicit or fallback entry must resolve canonically inside the canonical Tweak source directory and its canonical target must be a regular file. Reject explicit absolute, drive-qualified Windows, and `..` paths and in-project Junction/symlink paths whose canonical targets escape; out-of-tree build outputs must be copied or bundled into the project.
- Generated projects are runnable CommonJS and contain no unpublished npm dependency.
- Development source directories may live anywhere the user selects; only the live Junction destination is confined to an immediate child of `paths.tweaks`.
- `--replace` removes only a validated contained Junction. It never removes a real file/directory or a broken/malformed reparse point.
- The source watcher is Windows-only, recursive, debounced by 100 ms, ignores `node_modules` and Claude++ marker files, and never updates the marker after invalid source changes.
- Write `.claudepp-dev-reload` directly under `paths.tweaks`; do not depend on Junction event propagation.
- Do not change the Runtime watcher, Chokidar's default `followSymlinks: true`, its 250 ms debounce, Tweak lifecycle order, lease revocation, Safe Mode, MCP architecture, or platform support. This explicitly retains Codex++ behavior: direct Junction events may reload an invalid edit; the validated root marker is supplemental, not a reload gate.
- The portable ZIP contains a real `node_modules/@claude-plusplus/sdk`, never a workspace Junction.
- Tests use temporary APPDATA/LOCALAPPDATA/USERPROFILE roots and injected watchers/signals; no test touches live Claude++ data.

---

### Task 1: Shared SDK-backed project inspection and validation command

**Files:**
- Modify: `packages/installer/package.json`
- Modify: `package-lock.json`
- Create: `packages/installer/src/tweak-output.ts`
- Create: `packages/installer/src/tweak-project.ts`
- Create: `packages/installer/src/commands/validate-tweak.ts`
- Create: `packages/installer/test/tweak-project.test.ts`

**Interfaces:**
- Produces: `TweakCommandOutput { log, warn, error }`
- Produces: `inspectTweakProject(target?) => TweakProjectInspection`
- Produces: `requireValidTweakProject(target?) => ValidTweakProject`
- Produces: `validateTweak(target?, output?) => ValidTweakProject`
- Consumes: `@claude-plusplus/sdk.validateTweakManifest`

- [ ] **Step 1: Add the workspace SDK dependency and refresh only the lockfile metadata**

Add this runtime dependency to `packages/installer/package.json`:

```json
"@claude-plusplus/sdk": "*"
```

Run:

```powershell
npm install --package-lock-only --ignore-scripts
```

Inspect `package-lock.json` and confirm only `packages/installer.dependencies` gained the workspace SDK entry; no registry copy of the unpublished package appears.

- [ ] **Step 2: Write failing project-inspection tests**

Create `tweak-project.test.ts` with a temporary-directory helper and literal manifests. Cover directory and direct-manifest resolution, fallback precedence, explicit missing entry, invalid JSON, SDK errors, and warnings:

```ts
test("project inspection uses manifest.main then index.js/index.cjs/index.mjs", () => {
  withTempDir((root) => {
    writeManifest(root, { ...validManifest, main: "src/main.cjs" });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.cjs"), "module.exports = {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "src", "main.cjs"));
    assert.equal(inspectTweakProject(join(root, "manifest.json")).sourceDir, root);

    writeManifest(root, { ...validManifest, main: undefined });
    writeFileSync(join(root, "index.mjs"), "export default {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "index.mjs"));
    writeFileSync(join(root, "index.cjs"), "module.exports = {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "index.cjs"));
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "index.js"));
  });
});

test("project inspection returns every SDK issue and a missing-entry issue", () => {
  withTempDir((root) => {
    writeManifest(root, { id: "bad id", name: "", version: "bad", githubRepo: "bad" });
    const invalid = inspectTweakProject(root);
    assert.equal(invalid.manifest, null);
    assert.equal(invalid.entryPath, null);
    assert.ok(invalid.errors.some((issue) => issue.path === "id"));
    assert.ok(invalid.errors.some((issue) => issue.path === "githubRepo"));

    writeManifest(root, validManifest);
    const missing = inspectTweakProject(root);
    assert.deepEqual(missing.errors, [{
      path: "main",
      message: "entry file does not exist: index.js",
    }]);
  });
});

test("validate command prints warnings but fails only errors", () => {
  withTempDir((root) => {
    writeManifest(root, { ...validManifest, scope: undefined, main: "index.js" });
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    const messages = captureOutput();
    assert.doesNotThrow(() => validateTweak(root, messages.output));
    assert.ok(messages.warn.some((line) => line.includes("scope")));

    rmSync(join(root, "index.js"));
    assert.throws(() => validateTweak(root, messages.output), /1 error/);
    assert.ok(messages.error.some((line) => line.includes("entry file does not exist")));
  });
});
```

Use this literal valid manifest in the test rather than a production builder:

```ts
const validManifest = {
  id: "com.example.valid",
  name: "Valid",
  version: "0.1.0",
  githubRepo: "example/valid",
  scope: "both" as const,
  main: "index.js",
};
```

Also assert missing targets throw `target does not exist`, missing manifests throw `manifest not found`, and malformed JSON throws `manifest is not valid JSON`.

Add real-filesystem regression cases for an inconsistent empty-error inspection, explicit `../`, absolute, and drive-qualified Windows entries, an in-project Junction/symlink whose canonical target escapes the project, explicit and fallback directory entries, and fallback continuation to the next regular-file candidate. Retain the valid nested-entry and same-inspection/no-reinspection cases. Tests must use only temporary roots and must not touch live Claude++/Claude/Codex data.

- [ ] **Step 3: Run the focused test and verify RED**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-project.test.ts
```

Expected: FAIL because all three new source modules are absent.

- [ ] **Step 4: Implement output and project inspection**

Define the output seam in `tweak-output.ts`:

```ts
export interface TweakCommandOutput {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleTweakCommandOutput: TweakCommandOutput = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
```

Implement `tweak-project.ts` with these exact shapes and entry order:

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  validateTweakManifest,
  type TweakManifest,
  type TweakManifestIssue,
} from "@claude-plusplus/sdk";

export const TWEAK_ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"] as const;

export interface TweakProjectInspection {
  sourceDir: string;
  manifestPath: string;
  manifest: TweakManifest | null;
  entryPath: string | null;
  errors: TweakManifestIssue[];
  warnings: TweakManifestIssue[];
}

export interface ValidTweakProject extends TweakProjectInspection {
  manifest: TweakManifest;
  entryPath: string;
  errors: [];
}
```

`inspectTweakProject` resolves the target, rejects nonexistence, maps a directory to `manifest.json`, parses JSON once, runs the SDK validator once, and only resolves an entry after SDK success. An explicit `main` must be project-relative, must not be drive-qualified on Windows, and must contain no `..` path segment. Canonicalize the source directory and each existing explicit/fallback candidate, accept only canonical targets contained inside the canonical source directory whose `statSync(...).isFile()` is true, and convert a practical disappearance during `realpathSync`/`statSync` into the normal missing-entry validation issue. An in-project Junction/symlink that resolves outside is invalid. If explicit `main` is missing, append `{ path: "main", message: "entry file does not exist: <main>" }`; otherwise use `no entry file found; expected one of index.js, index.cjs, index.mjs`. Preserve `index.js`, `index.cjs`, `index.mjs` fallback precedence among acceptable regular files.

Export `requireValidInspection(inspection)` as the single narrowing helper. It throws one error containing every `<path>: <message>` line when `errors.length > 0`. With no reported errors it must still verify that both `manifest` and `entryPath` are non-null, reject an inconsistent structural inspection, and construct a sound `ValidTweakProject` with `errors: []` rather than cast. `requireValidTweakProject(target)` calls `inspectTweakProject` once and passes that result to the narrowing helper. Neither function suppresses warnings.

- [ ] **Step 5: Implement the validation command reporter**

```ts
export function validateTweak(
  target = ".",
  output: TweakCommandOutput = consoleTweakCommandOutput,
): ValidTweakProject {
  const inspection = inspectTweakProject(target);
  for (const issue of inspection.errors) output.error(`error ${issue.path}: ${issue.message}`);
  for (const issue of inspection.warnings) output.warn(`warn ${issue.path}: ${issue.message}`);
  if (inspection.errors.length > 0) {
    throw new Error(`tweak validation failed with ${inspection.errors.length} error(s)`);
  }
  const project = requireValidInspection(inspection);
  output.log(`valid ${project.manifest.id} (${project.entryPath})`);
  return project;
}
```

- [ ] **Step 6: Run test and build GREEN**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-project.test.ts
npm run build --workspace @claude-plusplus/installer
```

Expected: both exit 0 and the Installer build resolves the workspace SDK import.

- [ ] **Step 7: Commit Task 1**

```powershell
git add packages/installer/package.json package-lock.json packages/installer/src/tweak-output.ts packages/installer/src/tweak-project.ts packages/installer/src/commands/validate-tweak.ts packages/installer/test/tweak-project.test.ts
git commit -m "feat: validate Tweak projects with the public SDK"
```

---

### Task 2: Strict argument parsing for the authoring commands

**Files:**
- Create: `packages/installer/src/tweak-arguments.ts`
- Create: `packages/installer/test/tweak-arguments.test.ts`

**Interfaces:**
- Produces: `parseCreateTweakArguments(argv) => CreateTweakArguments`
- Produces: `parseValidateTweakArguments(argv) => ValidateTweakArguments`
- Produces: `parseDevTweakArguments(argv) => DevTweakArguments`

- [ ] **Step 1: Write failing parser table tests**

```ts
test("create parser accepts the complete command shape", () => {
  assert.deepEqual(parseCreateTweakArguments([
    "project", "--id", "com.example.one", "--name", "Example One",
    "--repo", "example/one", "--scope", "main", "--force",
  ]), {
    target: "project",
    id: "com.example.one",
    name: "Example One",
    repo: "example/one",
    scope: "main",
    force: true,
  });
});

test("validate and dev parsers apply their defaults", () => {
  assert.deepEqual(parseValidateTweakArguments([]), { target: "." });
  assert.deepEqual(parseValidateTweakArguments(["manifest.json"]), { target: "manifest.json" });
  assert.deepEqual(parseDevTweakArguments([]), {
    target: ".",
    replace: false,
    watch: true,
  });
  assert.deepEqual(parseDevTweakArguments([
    "project", "--name", "com.example.live", "--replace", "--no-watch",
  ]), {
    target: "project",
    name: "com.example.live",
    replace: true,
    watch: false,
  });
});
```

For each command, table-drive assertions that reject unknown flags, extra positionals, duplicate boolean/value flags, and missing values. For every value flag, include a single-dash next token such as `--id -x` and assert it is treated as an option error rather than consumed as a value. Also assert create rejects a missing target and scopes outside `renderer|main|both`.

- [ ] **Step 2: Run parser tests and verify RED**

```powershell
node --import tsx --test packages/installer/test/tweak-arguments.test.ts
```

Expected: FAIL because `tweak-arguments.ts` does not exist.

- [ ] **Step 3: Implement one strict internal parser and three typed adapters**

Use one internal parser so the rejection rules cannot diverge:

```ts
type FlagKind = "boolean" | "value";

function parseArguments(
  argv: string[],
  flags: Readonly<Record<string, FlagKind>>,
): { positionals: string[]; options: Map<string, string | true> } {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      if (token.startsWith("-")) throw new Error(`unknown option: ${token}`);
      positionals.push(token);
      continue;
    }
    const kind = flags[token];
    if (!kind) throw new Error(`unknown option: ${token}`);
    if (options.has(token)) throw new Error(`duplicate option: ${token}`);
    if (kind === "boolean") {
      options.set(token, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${token} requires a value`);
    options.set(token, value);
    index += 1;
  }
  return { positionals, options };
}
```

Create accepts exactly one positional and the five documented flags. Validate accepts zero or one positional and no flags. Dev accepts zero or one positional plus `--name`, `--replace`, `--no-watch`. Reject any token beginning with a single `-` as an unknown option rather than a positional. Validate `scope` in its typed adapter before returning.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run the focused parser test. Expected: all accepted and rejected table cases PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add packages/installer/src/tweak-arguments.ts packages/installer/test/tweak-arguments.test.ts
git commit -m "feat: parse Tweak authoring commands strictly"
```

---

### Task 3: Safe CommonJS Tweak scaffolding

**Files:**
- Create: `packages/installer/src/commands/create-tweak.ts`
- Create: `packages/installer/test/tweak-commands.test.ts`

**Interfaces:**
- Produces: `createTweak(target, options?, output?) => CreatedTweakProject`
- Consumes: `CreateTweakArguments` without its `target` field
- Produces: exactly four project files after complete preflight

- [ ] **Step 1: Write failing scaffold and preflight tests**

Use real temporary directories. Assert exact manifests for all scopes:

```ts
for (const [scope, permissions] of [
  ["renderer", ["settings"]],
  ["main", ["ipc"]],
  ["both", ["settings", "ipc"]],
] as const) {
  test(`create scaffolds ${scope} with only used permissions`, () => {
    withTempDir((root) => {
      const target = join(root, `my-${scope}-tweak`);
      createTweak(target, { scope }, silentOutput);
      const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
      assert.equal(manifest.id, `com.example.my-${scope}-tweak`);
      assert.equal(manifest.name, `My ${scope[0]!.toUpperCase()}${scope.slice(1)} Tweak`);
      assert.equal(manifest.githubRepo, `example/my-${scope}-tweak`);
      assert.equal(manifest.version, "0.1.0");
      assert.equal(manifest.description, "A Claude++ Tweak.");
      assert.equal(manifest.main, "index.js");
      assert.deepEqual(manifest.permissions, permissions);
      assert.deepEqual(readdirSync(target).sort(), [
        "README.md", "index.js", "manifest.json", "package.json",
      ]);
    });
  });
}
```

Add exact override assertions for `id`, `name`, `repo`, and scope. Parse `package.json` and assert it is private/CommonJS, contains only `validate` and `dev` scripts, and has neither dependencies nor devDependencies. Inspect each generated `index.js` and assert:

- Renderer contains `api.settings.registerPage`, stores its returned handle, and unregisters in `stop()`.
- Main checks `api.ipc.handle`, registers local channel `"ping"` (Runtime adds the Tweak-id namespace), and contains no DOM access.
- Both branches on `api.process`, uses local channel `"ping"` in both processes, unregisters its Settings handle, and has no `require(`, `import `, `React`, `Owl`, or external MCP configuration.

Load each generated CommonJS entry with `createRequire(import.meta.url)` and execute it against strict fake APIs. For Main, capture `ipc.handle(channel, handler)`, assert `channel === "ping"`, and assert the handler returns the generated pong text. For Renderer, capture the `registerPage` result, call `stop()`, and assert its `unregister()` runs. For both, execute separate freshly loaded module instances for Main and Renderer, assert Main handles `"ping"`, Renderer invokes `"ping"`, and the Settings handle is released. These executable tests must fail if a template passes a pre-namespaced channel that `tweakChannel` rejects.

For every generated scope, also assert that the loaded module exports callable `start` and `stop` functions. Invoke the Main-only template's `stop()` and assert it completes without throwing, so all three scaffolds protect the required cleanup hook rather than only documenting it.

Add refusal tests for an existing file, a non-empty directory even with `force: true`, and an empty directory without `force`. Assert an empty directory with `force: true` succeeds. For no-partial output:

```ts
test("invalid generated metadata creates no target directory", () => {
  withTempDir((root) => {
    const target = join(root, "invalid-output");
    assert.throws(
      () => createTweak(target, { id: "invalid id" }, silentOutput),
      /id:/,
    );
    assert.equal(existsSync(target), false);
  });
});
```

- [ ] **Step 2: Run scaffold tests and verify RED**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-commands.test.ts
```

Expected: FAIL because `create-tweak.ts` is absent.

- [ ] **Step 3: Implement complete preflight before any write**

Export:

```ts
export interface CreateTweakOptions {
  id?: string;
  name?: string;
  repo?: string;
  scope?: TweakScope;
  force?: boolean;
}

export interface CreatedTweakProject {
  directory: string;
  manifest: TweakManifest;
}
```

Resolve the target and derive slug/title first. If it exists, require `statSync(target).isDirectory()`, zero entries, and `force === true`; if it does not exist, do not create it yet. Construct the complete manifest, call `validateTweakManifest`, and throw joined `<path>: <message>` errors before `mkdirSync` or any file write.

After preflight, create the directory if needed and write exactly these values:

```ts
const packageJson = {
  name: slug,
  version: manifest.version,
  private: true,
  type: "commonjs",
  scripts: {
    validate: "claudeplusplus validate-tweak .",
    dev: "claudeplusplus dev .",
  },
};
```

The generated README must name the Tweak, list all four files, show `npm run validate`, `npm run dev`, `npm run dev -- --no-watch`, identify `%APPDATA%\\claude-plusplus\\tweaks` as the live destination, mention cleanup in `stop()`, and advise a Claude restart if Renderer changes do not apply to an existing Session.

- [ ] **Step 4: Run scaffold/project tests and build GREEN**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-project.test.ts packages/installer/test/tweak-commands.test.ts
npm run build --workspace @claude-plusplus/installer
```

Expected: all tests pass and every generated project validates through Task 1's shared inspector.

- [ ] **Step 5: Commit Task 3**

```powershell
git add packages/installer/src/commands/create-tweak.ts packages/installer/test/tweak-commands.test.ts
git commit -m "feat: scaffold runnable Claude++ Tweaks"
```

---

### Task 4: Containment-checked Windows development Junction and root marker

**Files:**
- Create: `packages/installer/src/tweak-dev-link.ts`
- Modify: `packages/installer/test/tweak-commands.test.ts`

**Interfaces:**
- Produces: `validateTweakLinkName(name) => string`
- Produces: `ensureDevTweakLink(sourceDir, linkPath, paths, replace) => "created"|"current"|"replaced"`
- Produces: `writeDevReloadMarker(paths, now?) => string`
- Produces: `prepareDevTweak(target?, options?, dependencies?) => DevTweakResult`

- [ ] **Step 1: Write failing one-shot dev-link tests**

Create source projects outside the temporary APPDATA tree, pass explicit temporary `paths`, and call `prepareDevTweak`. Cover:

```ts
test("dev preparation creates an immediate-child Junction and root marker", async () => {
  await withDevFixture(async ({ source, paths }) => {
    const result = prepareDevTweak(source, {}, {
      paths,
      now: () => 123,
      output: silentOutput,
    });
    const link = join(paths.tweaks, "com.example.dev");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(result.linkPath, link);
    assert.equal(readFileSync(join(paths.tweaks, ".claudepp-dev-reload"), "utf8"), "123");
    assert.equal(existsSync(join(source, ".claudepp-dev-reload")), false);
  });
});

async function withDevFixture(
  run: (fixture: {
    root: string;
    source: string;
    paths: ClaudePlusPlusPaths;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "claudepp-dev-"));
  try {
    const source = join(root, "source-project");
    createTweak(source, {
      id: "com.example.dev",
      name: "Dev",
      repo: "example/dev",
      scope: "both",
    }, silentOutput);
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "profile", "appdata"),
      LOCALAPPDATA: join(root, "profile", "localappdata"),
      USERPROFILE: join(root, "profile"),
    });
    await run({ root, source, paths });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

Add assertions for idempotent same-source linking, another valid source with the same id rejected without `replace`, replaced with `replace`, and marker refresh on idempotent linking. Assert a real file and real directory at the link path are rejected even with `replace`. Create a dangling Junction, then assert it is rejected and retained. On Windows, skip only that single dangling-Junction assertion if the fixture cannot create a Junction to a missing target; do not skip the rest of the test file.

Prove validation precedes live-root mutation:

```ts
test("dev preparation rejects an invalid source before creating the Tweaks root", async () => {
  await withDevFixture(async ({ source, paths }) => {
    rmSync(join(source, "index.js"));
    assert.throws(
      () => prepareDevTweak(source, {}, { paths, output: silentOutput }),
      /entry file does not exist/,
    );
    assert.equal(existsSync(paths.tweaks), false);
  });
});
```

Add a Windows-only preparation test that injects `platform: () => "linux"`, expects `Tweak development links require Windows`, and asserts `paths.tweaks` was not created.

Table-drive invalid names: `""`, `"."`, `".."`, `"a/b"`, `"a\\b"`, `"C:escape"`, and `"bad name"`. Assert no path outside `paths.tweaks` is created or removed.

- [ ] **Step 2: Run one-shot dev tests and verify RED**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-commands.test.ts
```

Expected: FAIL because `tweak-dev-link.ts` is absent.

- [ ] **Step 3: Implement link-name and immediate-child containment checks**

Use `win32.resolve`/`win32.relative` for the destination regardless of current path spelling:

```ts
export function validateTweakLinkName(name: string): string {
  if (name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Tweak link name may contain only letters, numbers, dots, underscores, and dashes");
  }
  return name;
}

export function assertWindowsTweakDevelopment(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    throw new Error("Tweak development links require Windows");
  }
}

function assertImmediateTweakLink(linkPath: string, paths: ClaudePlusPlusPaths): void {
  const root = win32.resolve(paths.tweaks);
  const target = win32.resolve(linkPath);
  const child = win32.relative(root, target);
  if (!child || child === "." || /^\.\.([\\/]|$)/.test(child) ||
      win32.isAbsolute(child) || child.includes("\\") || child.includes("/")) {
    throw new Error(`Tweak link must be an immediate child of ${paths.tweaks}`);
  }
}
```

Canonicalize the source with `realpathSync` and require a directory. Detect the destination with `lstatSync(linkPath, { throwIfNoEntry: false })`, not `existsSync`, so dangling Junctions are visible. Reject non-symbolic links. If `existsSync(linkPath)` is false after a reparse-point `lstat`, reject it as broken. Otherwise resolve the target with `realpathSync(linkPath)`, catch and report malformed targets, require the result to be a directory, and compare canonical paths case-insensitively. If it is the same source, return `current`; if different and `replace` is false, throw; if different and `replace` is true, re-run containment/reparse checks immediately before `rmSync(linkPath, { recursive: true, force: true })`, then create the Junction.

After source validation, immediate-child containment, and every collision/refusal preflight has succeeded, create `paths.tweaks` with `mkdirSync(paths.tweaks, { recursive: true })` immediately before creating a new Junction. Do not create the live Tweaks root for an invalid source, unsupported platform, invalid name, real-file/directory collision, broken link, or wrong-source collision without `--replace`.

Create links only with:

```ts
symlinkSync(canonicalSource, linkPath, "junction");
```

Do not add a non-Windows link mode.

- [ ] **Step 4: Implement the root marker and one-shot orchestrator**

```ts
export function writeDevReloadMarker(
  paths: ClaudePlusPlusPaths,
  now: () => number = Date.now,
): string {
  mkdirSync(paths.tweaks, { recursive: true });
  const marker = join(paths.tweaks, ".claudepp-dev-reload");
  writeFileSync(marker, String(now()), "utf8");
  return marker;
}
```

Use this dependency seam:

```ts
export interface PrepareDevTweakDependencies {
  paths: ClaudePlusPlusPaths;
  now(): number;
  output: TweakCommandOutput;
  platform(): NodeJS.Platform;
}
```

Accept it as `Partial<PrepareDevTweakDependencies>`. `prepareDevTweak` must call `assertWindowsTweakDevelopment((dependencies.platform ?? (() => process.platform))())` before validation or filesystem mutation, then require `statSync(resolve(target)).isDirectory()`, resolve `paths` from the injected dependency or `resolveClaudePlusPlusPaths()`, print every validation warning, default link name to `manifest.id`, validate the name, ensure the Junction, write the root marker, and return `{ sourceDir, linkPath, markerPath, manifest, linkStatus }`. It has no watcher behavior.

- [ ] **Step 5: Run one-shot tests and build GREEN**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-project.test.ts packages/installer/test/tweak-commands.test.ts
npm run build --workspace @claude-plusplus/installer
```

Expected: PASS; every link and marker is below the temporary APPDATA tree while every source is outside it.

- [ ] **Step 6: Commit Task 4**

```powershell
git add packages/installer/src/tweak-dev-link.ts packages/installer/test/tweak-commands.test.ts
git commit -m "feat: link Tweak projects for local development"
```

---

### Task 5: Deterministic source watcher and signal lifecycle

**Files:**
- Create: `packages/installer/src/tweak-dev-watch.ts`
- Create: `packages/installer/src/commands/dev-tweak.ts`
- Modify: `packages/installer/test/tweak-commands.test.ts`

**Interfaces:**
- Produces: `watchTweakProject(sourceDir, paths, dependencies?) => Promise<void>`
- Produces: `devTweak(target?, options?, dependencies?) => Promise<DevTweakResult>`
- Injects: recursive watcher, timer/clock, signal registration, marker writer, and output
- Preserves: existing Runtime root watcher as the only Runtime reload mechanism

- [ ] **Step 1: Write failing watcher tests with no real timing or process signals**

Build a fake watcher that captures its callback, a timer array whose callbacks run only when the test invokes them, and a signal map. Start `watchTweakProject`, then assert:

```ts
sourceListener?.("change", "src\\index.js");
sourceListener?.("change", "manifest.json");
sourceListener?.("change", "node_modules\\pkg\\index.js");
sourceListener?.("change", ".claudepp-dev-reload");
assert.deepEqual(delays, [100, 100]);
assert.equal(scheduled[0]?.cancelled, true);
assert.equal(scheduled[1]?.cancelled, false);
assert.equal(markerWrites, 0);
for (const timer of scheduled) {
  if (!timer.cancelled) await timer.callback();
}
assert.equal(markerWrites, 1);
```

Have the fake `setTimer` return the scheduled record itself and make `clearTimer` set its `cancelled` field, so the assertions exercise the actual handle passed by production code. Then make `manifest.json` SDK-invalid, trigger and settle another event, and assert `markerWrites` remains 1 while output contains `invalid`. Restore validity and prove a null filename still revalidates and updates the marker.

Invoke the captured SIGINT handler and await the watcher promise. Assert the pending timer was cleared, watcher closed once, and both SIGINT/SIGTERM handlers were removed. Repeat with SIGTERM in a fresh fixture. Also assert `watchFactory` received `{ recursive: true }`.

Capture the fake watcher's `error` listener in another fixture, leave a timer pending, emit `new Error("watch failed")`, and assert the returned promise rejects with `watch failed`. Prove the timer was canceled, the watcher closed once, both signal listeners were removed, and no marker was written.

Add an orchestration test that injects `prepare` and `watchForChanges`: default/watch true calls both in order and waits; `{ watch: false }` calls only prepare and returns its exact result.

- [ ] **Step 2: Run watcher tests and verify RED**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-commands.test.ts
```

Expected: FAIL because the watcher and `dev-tweak.ts` command modules are absent.

- [ ] **Step 3: Implement the injected Windows recursive watcher**

Define narrow dependencies:

```ts
export interface DevSourceWatcher {
  on(event: "error", listener: (error: unknown) => void): DevSourceWatcher;
  close(): void;
}

export interface TweakDevWatchDependencies {
  watchFactory(
    sourceDir: string,
    options: { recursive: true },
    listener: (event: string, filename: string | Buffer | null) => void,
  ): DevSourceWatcher;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
  onSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  now(): Date;
  platform(): NodeJS.Platform;
  writeMarker(paths: ClaudePlusPlusPaths): string;
  output: TweakCommandOutput;
}
```

`watchTweakProject` accepts `dependencies: Partial<TweakDevWatchDependencies> = {}` and fills each omitted member from the defaults below.

Default `watchFactory` wraps `fs.watch(sourceDir, { recursive: true }, listener)`, timers wrap `setTimeout`/`clearTimeout`, signals wrap `process.once`/`process.removeListener`, and `writeMarker` delegates to Task 4.

Call the same `assertWindowsTweakDevelopment` guard before `watchFactory`. Add a focused test with `platform: () => "linux"` proving `watchFactory`, signal installation, and marker writing remain untouched.

Normalize `filename` with `filename === null ? null : String(filename)`. Ignore any path matching `/(^|[\\/])node_modules([\\/]|$)/` and basenames `.claudepp-dev-reload` or `.claudepp-safe-mode-reload`. Each accepted event cancels the previous timer and schedules exactly 100 ms. The settled callback calls `requireValidTweakProject(sourceDir)`; on success it writes the marker and logs `valid HH:MM:SS (<relative path>)`; on failure it logs `invalid <message>` and leaves the marker untouched.

Do not describe this failure branch as preserving the active Runtime instance. Runtime independently follows the Junction, so the edit may already have triggered its 250-millisecond reload path. Do not add `followSymlinks: false`, descendant filtering, or a second Runtime watcher.

The returned promise installs both signal listeners and the watcher error listener. Implement one idempotent `finish(error?)` closure: cancel the pending timer, close the watcher once, unregister both signal listeners, and then resolve for SIGINT/SIGTERM or reject with `Tweak source watcher failed: <detail>` for a watcher error. Register `watcher.on("error", (error) => finish(error))`. Do not delete the Junction on exit.

- [ ] **Step 4: Wire the real watcher into `devTweak`**

Implement the command as a thin orchestrator over Task 4 and the watcher:

```ts
export async function devTweak(
  target = ".",
  options: DevTweakOptions = {},
  dependencies: Partial<DevTweakDependencies> = {},
): Promise<DevTweakResult> {
  const output = dependencies.output ?? consoleTweakCommandOutput;
  const paths = dependencies.paths ?? resolveClaudePlusPlusPaths();
  const prepare = dependencies.prepare ?? prepareDevTweak;
  const result = prepare(target, options, {
    paths,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    output,
  });
  if (options.watch === false) return result;
  output.log("watching for changes; press Ctrl+C to stop");
  const watchForChanges = dependencies.watchForChanges ??
    ((source, paths) => watchTweakProject(source, paths, {
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      output,
    }));
  await watchForChanges(result.sourceDir, paths);
  return result;
}
```

Define `DevTweakDependencies` with `paths`, `now`, `platform`, `output`, `prepare`, and `watchForChanges` members matching the calls above. After the initial valid link and root marker, return immediately when `watch === false`; otherwise log the watch instruction and await the watcher. Preserve the one-shot result fields after the watcher exits.

- [ ] **Step 5: Run watcher/command tests and build GREEN**

```powershell
npm run build --workspace @claude-plusplus/sdk
node --import tsx --test packages/installer/test/tweak-project.test.ts packages/installer/test/tweak-commands.test.ts
npm run build --workspace @claude-plusplus/installer
```

Expected: PASS without a real delay, real signal, live profile write, or second Runtime watcher.

- [ ] **Step 6: Commit Task 5**

```powershell
git add packages/installer/src/tweak-dev-watch.ts packages/installer/src/commands/dev-tweak.ts packages/installer/test/tweak-commands.test.ts
git commit -m "feat: validate and reload Tweak projects during development"
```

---

### Task 6: CLI wiring and portable SDK/authoring smoke coverage

**Files:**
- Modify: `packages/installer/src/cli.ts`
- Modify: `scripts/package-windows.ps1`
- Modify: `scripts/test-windows-package.ps1`

**Interfaces:**
- Adds: `create-tweak`, `validate-tweak`, and `dev` dispatch/help
- Packages: real `node_modules/@claude-plusplus/sdk/{package.json,dist}`
- Verifies: portable commands without system Node/npm or live Claude++ paths

- [ ] **Step 1: Wire commands and help, then verify the unmodified portable package fails**

Import the three commands and parsers. Dispatch exactly:

```ts
case "create-tweak": {
  const parsed = parseCreateTweakArguments(argv.slice(1));
  const { target, ...options } = parsed;
  createTweak(target, options);
  return;
}
case "validate-tweak": {
  const { target } = parseValidateTweakArguments(argv.slice(1));
  validateTweak(target);
  return;
}
case "dev": {
  const parsed = parseDevTweakArguments(argv.slice(1));
  const { target, ...options } = parsed;
  await devTweak(target, options);
  return;
}
```

Add the exact command shapes from the spec to help. Run the Installer build, then run `npm run package:windows` and `pwsh -NoProfile -File scripts/test-windows-package.ps1` before changing packaging. Expected smoke failure: the portable Installer imports an SDK dependency whose workspace Junction was removed.

- [ ] **Step 2: Materialize only the packaged SDK dependency**

Keep the current validation/removal of every workspace reparse point. After removing the empty `node_modules/@claude-plusplus` namespace, materialize the SDK from the already-copied public package:

```powershell
$sdkSource = Join-Path $payload 'packages\sdk'
$sdkTarget = Join-Path $payload 'node_modules\@claude-plusplus\sdk'
New-Item -ItemType Directory -Force -Path $sdkTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $sdkSource 'package.json') -Destination $sdkTarget
Copy-Item -LiteralPath (Join-Path $sdkSource 'dist') -Destination $sdkTarget -Recurse
```

Assert both source paths exist before copying, and run `Assert-ChildPath $payload $sdkTarget 'Packaged SDK dependency'`. Do not materialize Installer, Runtime, or Loader links.

- [ ] **Step 3: Extend portable smoke checks**

Replace the old blanket rejection of `node_modules/@claude-plusplus` with assertions that:

- the namespace contains exactly `sdk`;
- `sdk` is not a reparse point;
- `sdk/package.json`, `sdk/dist/index.js`, and `sdk/dist/index.d.ts` exist;
- no other `@claude-plusplus` dependency or stale workspace launcher exists.

Inside the existing redirected APPDATA/LOCALAPPDATA/USERPROFILE block, run:

```powershell
$tweakSource = Join-Path $testRoot 'authoring\package-smoke'
& $command create-tweak $tweakSource --id com.example.package-smoke --name 'Package Smoke' --repo example/package-smoke --scope both
if ($LASTEXITCODE -ne 0) { throw 'Packaged create-tweak failed' }
& $command validate-tweak $tweakSource
if ($LASTEXITCODE -ne 0) { throw 'Packaged validate-tweak failed' }
& $command dev $tweakSource --no-watch
if ($LASTEXITCODE -ne 0) { throw 'Packaged dev --no-watch failed' }

$liveRoot = Join-Path $env:APPDATA 'claude-plusplus\tweaks'
$liveLink = Join-Path $liveRoot 'com.example.package-smoke'
if (!(Test-Path -LiteralPath $liveLink)) { throw 'Packaged dev link is missing' }
if (((Get-Item -LiteralPath $liveLink -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw 'Packaged dev link is not a Junction'
}
if (!(Test-Path -LiteralPath (Join-Path $liveRoot '.claudepp-dev-reload'))) {
    throw 'Packaged dev reload marker is missing'
}
```

Before leaving the redirected environment block, verify containment without inspecting or modifying the user's original APPDATA:

```powershell
$resolvedProfileRoot = [System.IO.Path]::GetFullPath((Join-Path $testRoot 'profile')).TrimEnd('\') + '\'
$resolvedLiveLink = [System.IO.Path]::GetFullPath($liveLink)
if (!$resolvedLiveLink.StartsWith($resolvedProfileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Packaged dev link escaped the isolated profile: $resolvedLiveLink"
}
```

- [ ] **Step 4: Rebuild the portable package and verify GREEN**

```powershell
npm run package:windows
pwsh -NoProfile -File scripts/test-windows-package.ps1
```

Expected: both exit 0; portable version/status/Doctor plus create/validate/dev pass with PATH restricted to System32.

- [ ] **Step 5: Commit Task 6**

```powershell
git add packages/installer/src/cli.ts scripts/package-windows.ps1 scripts/test-windows-package.ps1
git commit -m "feat: ship Tweak authoring commands in Windows releases"
```

---

### Task 7: Complete author documentation and release inclusion

**Files:**
- Create: `docs/tweaks/README.md`
- Create: `docs/tweaks/getting-started.md`
- Create: `docs/tweaks/manifest.md`
- Create: `docs/tweaks/runtime-lifecycle.md`
- Create: `docs/tweaks/api-reference.md`
- Create: `docs/tweaks/typescript-and-bundling.md`
- Create: `docs/tweaks/distribution-debugging.md`
- Modify: `docs/tweak-authoring.md`
- Modify: `README.md`
- Modify: `scripts/package-windows.ps1`
- Modify: `scripts/test-windows-package.ps1`

- [ ] **Step 1: Add failing release-document checks**

Extend the package smoke required-files array with all seven `docs\\tweaks\\*.md` files. After extraction, parse `docs/tweaks/README.md` as text and assert it contains relative links to the other six pages and `../tweak-authoring.md`. Run the existing smoke against the current archive. Expected: FAIL because the new directory is absent.

- [ ] **Step 2: Write the documentation index and six focused guides**

Use these exact responsibilities, without duplicating contradictory API promises:

- `docs/tweaks/README.md`: short orientation and links to all six guides plus the advanced Claude capability guide.
- `getting-started.md`: four-file layout; exact create/validate/dev command shapes; Renderer/Main/both scopes; explicit-main and fallback entry order; `%APPDATA%\\claude-plusplus\\tweaks`; restart caveat.
- `manifest.md`: a table for every current `TweakManifest` field; all nine permission strings; Main-capable restrictions; exact startup-environment and Claude Code declaration/permission coupling; numeric `minRuntime`; Store metadata guidance.
- `runtime-lifecycle.md`: discovery/start/stop, Main lease revocation, module-cache clear, Renderer reconstruction, the 100 ms dev validation loop and independent 250 ms Runtime Junction-following debounce, the supplemental marker, the possibility that invalid edits unload/fail rediscovery and that direct/marker events may not coalesce, Safe Mode behavior, cleanup checklist, Tweak/data/log locations.
- `api-reference.md`: public SDK interfaces grouped into always-present common (`manifest`, storage, log, IPC), cross-process permission-gated `fs` operations (`filesystem`), Renderer permission-gated `settings` (`settings`) and `claude.sessions` (`claude-sessions`), and Main permission-gated session titles, startup environment, Claude Code settings, and in-process MCP. State explicitly that Renderer has no Node `require` and permissions are API leases, not an OS sandbox.
- `typescript-and-bundling.md`: local SDK install from `%USERPROFILE%\\.claude-plusplus\\source\\packages\\sdk`; `import type` examples; esbuild CommonJS examples for `platform=browser` Renderer and `platform=node` Main; both-process modules avoid top-level DOM/Node assumptions and use a neutral/shared bundle; no JSX/React promise.
- `distribution-debugging.md`: validate/build checklist, GitHub `owner/repo`, reviewed Store commits, compatibility/minRuntime, Main log and DevTools locations, invalid-watch behavior, uninstall/data cleanup, trusted-local-code warning.

At the top of `docs/tweak-authoring.md`, link back to the new index and label the Claude Code settings, in-process MCP, session-title, and startup-environment material as advanced Claude-specific capabilities. The current guide has no startup-environment section: add one from `packages/runtime/src/startup-environment.ts`, `packages/runtime/src/startup-environment-store.ts`, the SDK declaration/API types, and the production GPT Context Window design/example. Cover declaration/permission coupling, Main-only lease access, saved/applied/restart-required status, atomic save, baseline-safe relaunch, lease lifetime, and recovery expectations. Replace the README's single authoring link with the index and an advanced-guide link.

Validate every API name and permission against `packages/sdk/src/index.ts`; do not copy Codex-only APIs or external MCP declarations.

- [ ] **Step 3: Package the complete docs directory**

After creating `$payload\\docs`, copy recursively:

```powershell
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\tweaks') -Destination (Join-Path $payload 'docs\tweaks') -Recurse
```

Retain the existing separate copy of `docs/tweak-authoring.md`.

- [ ] **Step 4: Run complete verification**

Run separately:

```powershell
npm run build
```

```powershell
npm test
```

```powershell
npm run package:windows
pwsh -NoProfile -File scripts/test-windows-package.ps1
```

Expected: all commands exit 0; Node reports zero failures/skips/todos/cancellations; the portable smoke runs authoring commands in redirected profile roots and finds all seven documents.

- [ ] **Step 5: Inspect scope and safety**

```powershell
git diff --check
git status --short
git diff --stat
```

Confirm no docs mention Codex-only APIs, external MCP configuration, macOS/Linux links, or an npm-published Claude++ SDK. Confirm generated ZIP/staging outputs are not staged and no test-created Junction remains outside temporary roots.

- [ ] **Step 6: Commit Task 7**

```powershell
git add README.md docs/tweak-authoring.md docs/tweaks scripts/package-windows.ps1 scripts/test-windows-package.ps1
git commit -m "docs: add the complete Tweak author workflow"
```
