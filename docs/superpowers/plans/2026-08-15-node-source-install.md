# Node.js Source Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `install.ps1` install either a self-contained Windows release or a source checkout built with an already installed Node.js 24+ and npm.

**Architecture:** Select packaged or source mode from the original payload before copying it. Keep the packaged `.cmd` path unchanged; in source mode validate the system toolchain, build the checkout, copy the built tree into the canonical managed source directory, and invoke its JavaScript launcher with the validated Node executable.

**Tech Stack:** PowerShell 7, Node.js 24+, npm workspaces, Node.js built-in test runner.

## Global Constraints

- The script must never download or install Node.js.
- Source mode requires Node.js 24 or newer and `npm.cmd` on `PATH`.
- Packaged releases must continue working without system Node.js or npm.
- Installation must continue targeting `%USERPROFILE%\.claude-plusplus\source` and retain the existing managed-root guard.
- Mode selection must use the original payload, not possibly stale files in the managed destination.
- Do not publish an npm package or change update-channel behavior.
- Do not create a Git commit unless the user explicitly requests one.

---

### Task 1: Cover Installer Mode Selection and Toolchain Validation

**Files:**
- Create: `test/install-script.test.mjs`
- Modify: `install.ps1`

**Interfaces:**
- Consumes: the existing parameterless `install.ps1` entry point and the two launchers `bin\claudeplusplus.cmd` and `bin\claudeplusplus.js`.
- Produces: installer behavior selected from the original payload, with source mode accepting Node.js `>=24.0.0` plus `npm.cmd` and packaged mode requiring neither.

- [x] **Step 1: Write the failing PowerShell integration tests**

Create `test/install-script.test.mjs`. Use `mkdtempSync`, `cpSync`, `mkdirSync`, `writeFileSync`, `rmSync`, and `spawnSync` to construct a temporary payload and isolated profile for every test. Resolve `pwsh.exe` once with `where.exe pwsh`, then run the copied script by absolute path so a deliberately restricted test `PATH` does not hide PowerShell itself.

The fixture must create command shims in a temporary `commands` directory. The `node.cmd` shim prints `%FAKE_NODE_VERSION%` for `--version`; for other arguments it appends `node %*` to `%CLAUDE_PLUSPLUS_TEST_LOG%` and exits zero. The `npm.cmd` shim appends `npm %*` to the same log and exits zero. A packaged `bin\claudeplusplus.cmd` shim appends `packaged %*` and exits zero. A source `bin\claudeplusplus.js` can contain `process.exit(0);` because the Node shim records rather than executes it.

Add these tests using real `install.ps1` execution:

```js
test("installs a packaged release without probing system Node.js", () => {
  const result = runInstaller({ mode: "packaged", pathMode: "system-only" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /packaged install/);
  assert.doesNotMatch(result.log, /node |npm /);
});

test("builds and installs a source checkout with Node.js 24", () => {
  const result = runInstaller({ mode: "source", nodeVersion: "v24.19.0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /npm ci --workspaces --include-workspace-root --ignore-scripts/);
  assert.match(result.log, /npm run build/);
  assert.match(result.log, /node .*bin[\\/]claudeplusplus\.js install/);
});

test("rejects source installation when Node.js is missing", () => {
  const result = runInstaller({ mode: "source", pathMode: "system-only" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 24 or newer is required/i);
  assert.doesNotMatch(result.log, /npm /);
});

test("rejects source installation with Node.js 23", () => {
  const result = runInstaller({ mode: "source", nodeVersion: "v23.11.0" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 24 or newer is required.*v23\.11\.0/is);
  assert.doesNotMatch(result.log, /npm /);
});

test("rejects source installation when npm is missing", () => {
  const result = runInstaller({ mode: "source", nodeVersion: "v24.19.0", includeNpm: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm is required/i);
});

test("rejects a payload without either launcher", () => {
  const result = runInstaller({ mode: "invalid", nodeVersion: "v24.19.0" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claudeplusplus\.cmd/);
  assert.match(result.stderr, /claudeplusplus\.js/);
});
```

Always clean up only the exact directory returned by `mkdtempSync` in a `t.after()` callback.

- [x] **Step 2: Run the integration tests and verify the source cases fail for the current bug**

Run:

```powershell
node --test test/install-script.test.mjs
```

Expected: the packaged test passes, while the valid source test fails with `Bundled Claude++ CLI is missing`; the missing/outdated toolchain tests fail because the current script has no Node.js-specific diagnostics.

- [x] **Step 3: Implement explicit packaged and source modes in `install.ps1`**

Add a checked external-command helper:

```powershell
function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$Label) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}
```

Before copying, resolve the two source launchers and select exactly one mode:

```powershell
$packagedLauncher = Join-Path $source 'bin\claudeplusplus.cmd'
$nodeLauncher = Join-Path $source 'bin\claudeplusplus.js'
$isPackaged = Test-Path -LiteralPath $packagedLauncher
if (!$isPackaged -and !(Test-Path -LiteralPath $nodeLauncher)) {
    throw "Claude++ CLI is missing. Expected either: $packagedLauncher or $nodeLauncher"
}
```

For source mode, resolve application commands only, validate the exact `node --version` result with
`^v(?<major>\d+)\.\d+\.\d+$`, reject major versions below 24, resolve `npm.cmd`, and build in `$source`:

```powershell
$nodeCommand = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw 'Node.js 24 or newer is required to install Claude++ from source. Install Node.js and retry.'
}
$nodePath = $nodeCommand.Source
$nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(?<major>\d+)\.\d+\.\d+$') {
    throw "Could not determine the installed Node.js version: $nodeVersion"
}
if ([int]$Matches.major -lt 24) {
    throw "Node.js 24 or newer is required to install Claude++ from source; found $nodeVersion."
}
$npmCommand = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    throw 'npm is required to install Claude++ from source. Install npm and retry.'
}
Push-Location $source
try {
    Invoke-Checked $npmCommand.Source @('ci', '--workspaces', '--include-workspace-root', '--ignore-scripts') 'Claude++ dependency installation'
    Invoke-Checked $npmCommand.Source @('run', 'build') 'Claude++ source build'
} finally {
    Pop-Location
}
```

Keep the existing guarded copy. After it completes, invoke the destination launcher for the selected mode:

```powershell
if ($isPackaged) {
    Invoke-Checked (Join-Path $destination 'bin\claudeplusplus.cmd') @('install') 'Claude++ install command'
} else {
    Invoke-Checked $nodePath @((Join-Path $destination 'bin\claudeplusplus.js'), 'install') 'Claude++ install command'
}
```

- [x] **Step 4: Run the focused test and verify every mode passes**

Run:

```powershell
node --test test/install-script.test.mjs
```

Expected: all six tests pass with no warnings or unexpected output.

---

### Task 2: Document Source Installation and Run Regression Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the source-mode behavior implemented by Task 1.
- Produces: user-facing source installation instructions that state the Node.js/npm requirements and the no-download failure behavior.

- [x] **Step 1: Add concise source installation instructions**

After the packaged release paragraph in `README.md`, add:

````markdown
To install from source, install Node.js 24 or newer with npm, clone the repository, and run:

```powershell
pwsh -File .\install.ps1
```

The script builds the checkout with npm before installing it. It does not download or install Node.js; when Node.js
24+ or npm is unavailable, it prints the requirement and exits without starting installation.
````

Do not add a test that matches the README wording. Source installation behavior is covered by the PowerShell integration
tests in Task 1; prose intended for people is reviewed directly.

- [x] **Step 2: Run focused installer and repository tests**

Run:

```powershell
node --test test/install-script.test.mjs test/repository-shape.test.mjs
```

Expected: all installer and repository-shape tests pass.

- [x] **Step 3: Run the full repository test suite**

Run:

```powershell
npm test
```

Expected: the build succeeds and every test passes.

- [x] **Step 4: Verify the final patch is clean**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits zero; status lists only the approved design/plan, `install.ps1`, `README.md`, and `test/install-script.test.mjs`.
