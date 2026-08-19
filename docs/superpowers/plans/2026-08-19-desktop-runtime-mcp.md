# Claude Desktop Runtime MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed, in-process Claude Desktop MCP host to Claude++ 0.2.6 and ship an independent Session Title Tweak at `D:\Unity\claude-session-title`.

**Approved Codex++ divergence:** Codex++ manifest MCP uses external `command`/`args`/`env` and synchronizes a managed block into `~/.codex/config.toml`. The user explicitly approved Claude++'s deliberate divergence to Claude Desktop-only, in-process handler registration with revocable leases and an exact-build private adapter, with no Claude MCP or settings configuration writes; this is an intentional architectural difference, not an omitted config-sync step.

**Architecture:** Claude++ observes four version-locked Claude Desktop CommonJS modules before the original Desktop entry finishes loading, then wraps the exported MCP coordinator's `createAllServers` boundary. Main Tweaks register handler-backed SDK MCP definitions in a process-wide lease registry; the host creates one SDK server instance per session and reconciles live queries through Desktop's existing idle/deferred update path. A separate Main-only title capability calls the exported Desktop session manager with an explicit session ID and verifies the persisted result.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner, esbuild CommonJS Runtime bundle, Electron main process, Claude Agent SDK in-process MCP objects, CommonJS JavaScript Tweak.

**Spec:** `docs/superpowers/specs/2026-08-19-desktop-runtime-mcp-design.md`

## Global Constraints

- Support Claude Desktop `1.26832.0` initially; version, exact chunk SHA-256, and runtime shape must all match.
- Never write `~/.claude.json`, `.mcp.json`, Claude `settings.json`, or an MCP managed block, and never modify `app.asar`.
- Do not hook `child_process.spawn`, do not patch `ccd_session_mgmt`, and do not add Renderer route inference or `PreToolUse`.
- Server names must start with `claudepp_`; the shipped server is `claudepp_session_title`.
- The shipped tool is `set_session_title` with required `session_id` and `title` string fields.
- Title updates use `titleSource: "user"`, enforce a trimmed 1..200 UTF-16-code-unit title, and succeed only after exact read-back.
- Main Tweak leases own all registrations; stop, disable, reload, Safe Mode, and app quit must revoke handlers.
- Unsupported Desktop builds keep Claude running and inject nothing; no fallback may write configuration or patch another private path.
- Runtime/SDK/Installer/Loader release version is `0.2.6`; the external Tweak version is `0.1.0` and requires Runtime `0.2.6`.
- Preserve the unrelated untracked `D:\Unity\claude-plusplus\test-orange-cat.png` file unchanged and outside all commits.
- The external Tweak directory is not automatically initialized as a Git repository; do not create repository metadata without separate user authorization.

---

### Task 1: SDK permissions and public contracts

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/test/manifest-validation.test.ts`

**Interfaces:**
- Produces: `TweakMcpApi`, `TweakMcpServer`, `TweakMcpTool`, `TweakMcpRegistration`, `TweakMcpCallResult`, `TweakMcpToolContext`, `ClaudeSessionTitlesApi`, and `ClaudeSessionTitleUpdate`.
- Produces: Main-only permissions `mcp` and `claude-session-title-write`.
- Consumed by: Tasks 2, 4, 5, and 6.

- [ ] **Step 1: Write failing manifest and type-contract tests**

Add tests whose production-breaking mutations are removal of either permission, accidental Renderer exposure, or loss of the explicit-ID API:

```ts
test("accepts Main runtime MCP and session title permissions", () => {
  const result = validateTweakManifest({
    id: "com.example.title",
    name: "Title",
    version: "0.1.0",
    githubRepo: "example/title",
    scope: "main",
    permissions: ["mcp", "claude-session-title-write"],
  });
  assert.equal(result.ok, true);
});

test("rejects Main-only MCP permissions on a Renderer Tweak", () => {
  for (const permission of ["mcp", "claude-session-title-write"] as const) {
    const result = validateTweakManifest({
      id: `com.example.${permission}`,
      name: permission,
      version: "0.1.0",
      githubRepo: "example/renderer",
      scope: "renderer",
      permissions: [permission],
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.path === "permissions[0]"), true);
  }
});
```

Extend the existing public-contract test with literal tool input/output and a `sessionId` argument. Do not assert only that fields exist; invoke the typed functions and assert their results.

- [ ] **Step 2: Run the SDK test and verify RED**

Run:

```powershell
node --import tsx --test packages/sdk/test/manifest-validation.test.ts
```

Expected: FAIL because both permissions and the MCP/title types are absent.

- [ ] **Step 3: Add the minimal SDK types and validation**

Add these contracts, retaining the existing Renderer `ClaudeSessionsApi` unchanged:

```ts
export interface TweakMcpToolContext {
  callerSessionId: string;
}

export interface TweakMcpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface TweakMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    input: Record<string, unknown>,
    context: TweakMcpToolContext,
  ): TweakMcpCallResult | Promise<TweakMcpCallResult>;
}

export interface TweakMcpServer {
  name: string;
  version?: string;
  tools: readonly TweakMcpTool[];
}

export interface TweakMcpRegistration {
  unregister(): Promise<void>;
}

export interface TweakMcpApi {
  registerServer(server: TweakMcpServer): Promise<TweakMcpRegistration>;
}

export interface ClaudeSessionTitleUpdate {
  sessionId: string;
  title: string;
}

export interface ClaudeSessionTitlesApi {
  setTitle(sessionId: string, title: string): Promise<ClaudeSessionTitleUpdate>;
}
```

Make `ClaudeApi.sessions` optional and add optional `sessionTitles`; add optional `mcp` to `TweakApi`. Validate both new permissions as invalid when `scope === "renderer"`.

- [ ] **Step 4: Run SDK tests and build GREEN**

Run:

```powershell
node --import tsx --test packages/sdk/test/manifest-validation.test.ts
npm run build --workspace @claude-plusplus/sdk
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the SDK contract in the Claude++ repository**

```powershell
git add packages/sdk/src/index.ts packages/sdk/test/manifest-validation.test.ts
git commit -m "feat: define runtime MCP tweak contracts"
```

Do not add `test-orange-cat.png`.

### Task 2: Lease-owned MCP registry

**Files:**
- Create: `packages/runtime/src/tweak-mcp-registry.ts`
- Create: `packages/runtime/test/tweak-mcp-registry.test.ts`

**Interfaces:**
- Consumes: `TweakMcpApi`, `TweakMcpServer`, `TweakMcpCallResult`, and `TweakManifest` from Task 1.
- Produces: `TweakMcpRegistry`, `RegisteredTweakMcpServer`, `createApiLease(manifest)`, `snapshot()`, `invoke(...)`, and `subscribe(...)`.
- Consumed by: Tasks 4 and 5.

- [ ] **Step 1: Write failing registry behavior tests**

Cover one observable break per test:

```ts
test("registers one namespaced server and routes a tool call", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const registration = await lease.api.registerServer(server("claudepp_title", "v1"));

  assert.deepEqual(registry.snapshot().map((entry) => entry.name), ["claudepp_title"]);
  assert.deepEqual(
    await registry.invoke("claudepp_title", "set", { title: "A" }, { callerSessionId: "caller" }),
    { content: [{ type: "text", text: "v1:A:caller" }] },
  );

  await registration.unregister();
  await assert.rejects(
    () => registry.invoke("claudepp_title", "set", { title: "A" }, { callerSessionId: "caller" }),
    /not active/,
  );
});
```

Add separate tests for invalid prefix, duplicate tool names, active server collision, idempotent unregister, API-lease disposal, retained references, change notifications, and same-owner handler replacement with an identical structural definition. Add a test that rejects a same-name hot replacement whose schema or tool list differs.

- [ ] **Step 2: Run the registry test and verify RED**

```powershell
node --import tsx --test packages/runtime/test/tweak-mcp-registry.test.ts
```

Expected: FAIL because `tweak-mcp-registry.ts` does not exist.

- [ ] **Step 3: Implement registration validation and revocable invocation**

Use a canonical structural fingerprint made from server name, version, tool names, descriptions, and JSON schemas, excluding handler function identities. Each invocation resolves the currently active registry entry instead of closing over the original Tweak module. Notifications contain the active snapshot and all managed names so removal can be reconciled safely.

The lease shape is:

```ts
export interface TweakMcpApiLease {
  api: TweakMcpApi;
  dispose(): Promise<void>;
}
```

Every retained method checks an `active` flag. `dispose()` revokes first, unregisters all owned servers, emits one final change, and is idempotent.

- [ ] **Step 4: Run registry tests GREEN**

```powershell
node --import tsx --test packages/runtime/test/tweak-mcp-registry.test.ts
npm run build --workspace @claude-plusplus/runtime
```

Expected: PASS.

- [ ] **Step 5: Commit the registry**

```powershell
git add packages/runtime/src/tweak-mcp-registry.ts packages/runtime/test/tweak-mcp-registry.test.ts
git commit -m "feat: add lease-owned MCP registry"
```

### Task 3: Version-locked Claude Desktop module observer

**Files:**
- Create: `packages/runtime/src/claude-desktop-mcp-compat.ts`
- Create: `packages/runtime/test/claude-desktop-mcp-compat.test.ts`

**Interfaces:**
- Produces: `ClaudeDesktopMcpBindings`, `ClaudeDesktopMcpCompatibility`, `installModuleObserver()`, and `dispose()`.
- Consumed by: Task 4.

- [ ] **Step 1: Write failing probe and restoration tests**

Build tests around real exported behavior, using temporary CommonJS modules with complete fake export shapes and injected literal hashes. Verify:

- exact Desktop version plus all four exact hashes yields bindings once;
- a wrong version, any wrong hash, or any missing method yields unsupported status and no bindings;
- the observer restores the original `Module._load` after success and after a terminal mismatch;
- a consumer exception never changes the module's original export or prevents it loading;
- `dispose()` restores only when the currently installed wrapper is the observer's own wrapper.

The successful binding fixture must include:

```ts
const coordinator = class {
  public sessionType = "ccd";
  public async createAllServers(): Promise<Record<string, unknown>> { return {}; }
};

const sessionManager = {
  sessions: new Map(),
  getSession: async () => null,
  updateSession: async () => {},
  applyMcpServersIfIdle: async () => {},
};
```

- [ ] **Step 2: Run compatibility tests and verify RED**

```powershell
node --import tsx --test packages/runtime/test/claude-desktop-mcp-compat.test.ts
```

Expected: FAIL because the compatibility observer is absent.

- [ ] **Step 3: Implement the exact build adapter**

Encode the four filenames and SHA-256 values from the spec. For version `1.26832.0`, synchronously wrap `Module._load`, call the original first, resolve the loaded filename, hash only the four expected basenames, and retain exports only when their complete shape matches. Do not install any coordinator patch in this task.

The resulting binding contract contains:

```ts
export interface ClaudeDesktopMcpBindings {
  coordinatorConstructor: {
    prototype: { createAllServers: (...args: unknown[]) => Promise<Record<string, unknown>> };
  };
  createSdkMcpServer(options: Record<string, unknown>): SdkMcpServer;
  jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, unknown>;
  sessionManager: ClaudeDesktopSessionManager;
}
```

Log only version, basename, boolean probe outcome, and an error category. Never log source text or full paths containing user data beyond the bundled module basename.

- [ ] **Step 4: Run compatibility tests and Runtime build GREEN**

```powershell
node --import tsx --test packages/runtime/test/claude-desktop-mcp-compat.test.ts
npm run build --workspace @claude-plusplus/runtime
```

Expected: PASS.

- [ ] **Step 5: Commit the compatibility observer**

```powershell
git add packages/runtime/src/claude-desktop-mcp-compat.ts packages/runtime/test/claude-desktop-mcp-compat.test.ts
git commit -m "feat: probe Claude Desktop MCP internals"
```

### Task 4: In-process MCP host, active reconciliation, and title writes

**Files:**
- Create: `packages/runtime/src/claude-desktop-mcp-service.ts`
- Create: `packages/runtime/test/claude-desktop-mcp-service.test.ts`

**Interfaces:**
- Consumes: `TweakMcpRegistry` from Task 2 and `ClaudeDesktopMcpBindings` from Task 3.
- Produces: `ClaudeDesktopMcpService`, `createMcpApiLease(manifest)`, `createSessionTitlesApiLease()`, `installEarly()`, `reconcileActiveSessions()`, and `dispose()`.
- Consumed by: Task 5.

- [ ] **Step 1: Write failing new-session injection tests**

Use a real `TweakMcpRegistry` and fake SDK server factory. Assert that the wrapped coordinator:

- preserves the original server record;
- injects `claudepp_session_title` only for `sessionType === "ccd"`;
- creates distinct SDK server objects for two session IDs;
- converts the declared JSON Schema and marks the server always loaded;
- skips and logs a key collision without replacing the original value;
- returns the original record when custom server construction throws.

Invoke the captured SDK handler and assert that it routes through the current registry handler with the literal caller session ID.

- [ ] **Step 2: Run the host test and verify RED**

```powershell
node --import tsx --test packages/runtime/test/claude-desktop-mcp-service.test.ts
```

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement coordinator wrapping and dynamic handler routing**

After compatibility bindings are complete, atomically replace `coordinatorConstructor.prototype.createAllServers` with a wrapper. The wrapper awaits the original, then creates a fresh SDK server per active registry definition and caller session. The SDK handler calls:

```ts
registry.invoke(serverName, toolName, input, { callerSessionId: sessionId })
```

Catch a revoked or Tweak handler error and convert it to:

```ts
{
  content: [{ type: "text", text: errorMessage }],
  isError: true,
}
```

Restore the prototype only when it still contains this service's wrapper.

- [ ] **Step 4: Add failing active-session reconciliation tests**

Add literal session fixtures for idle, running, and cold sessions. Verify:

- idle query: the injected entry is written to `activeMcpServers` and `applyMcpServersIfIdle` is called;
- running query: the same Desktop method receives the next map and the fake records deferred state;
- no query: no SDK instance is created until `createAllServers` runs;
- removal deletes only the exact object injected by Claude++;
- an object with the same key but different identity is preserved;
- registry handler replacement with the same structural definition lets an already captured SDK handler call the new implementation;
- disposal revokes handlers before reconciliation.

Run the test once and confirm the new reconciliation cases fail for the expected missing behavior.

- [ ] **Step 5: Implement serialized reconciliation**

Serialize registry changes through one promise queue. Track per-session injected object identities and every managed server name. For each live query, create or preserve the session-specific SDK instance, update a cloned `activeMcpServers` record, assign it back, and call Desktop's `applyMcpServersIfIdle`. Do not call Desktop `saveSession` for MCP state.

When a same-name registration returns after hot reload with an identical fingerprint, old SDK handlers continue to resolve the new registry handler. Reject a changed fingerprint for the lifetime of the Desktop process.

- [ ] **Step 6: Add failing title update tests**

Write separate tests for current and other session IDs using the same code path, plus empty ID, empty title, 201-character title, unknown ID, update throw, deleted-after-update, and read-back mismatch. The success test must assert the exact lower-level call:

```ts
assert.deepEqual(updates, [[
  "current-session-id",
  { title: "New title", titleSource: "user" },
]]);
```

- [ ] **Step 7: Implement the title API lease**

Trim both inputs, check the 200-code-unit boundary, read the target, update through `sessionManager.updateSession`, read again, and return `{ sessionId, title }` only on an exact match. A disposed lease throws before the first manager read. Do not special-case the caller's session ID and do not log title text.

- [ ] **Step 8: Run all service tests GREEN**

```powershell
node --import tsx --test packages/runtime/test/tweak-mcp-registry.test.ts packages/runtime/test/claude-desktop-mcp-compat.test.ts packages/runtime/test/claude-desktop-mcp-service.test.ts
npm run build --workspace @claude-plusplus/runtime
```

Expected: PASS.

- [ ] **Step 9: Commit the MCP host and title service**

```powershell
git add packages/runtime/src/claude-desktop-mcp-service.ts packages/runtime/test/claude-desktop-mcp-service.test.ts
git commit -m "feat: inject in-process MCP servers into Desktop sessions"
```

### Task 5: Main Tweak API and early Runtime lifecycle integration

**Files:**
- Modify: `packages/runtime/src/tweak-api.ts`
- Modify: `packages/runtime/test/tweak-api.test.ts`
- Modify: `packages/runtime/src/main.ts`
- Modify: `packages/runtime/test/main.test.ts`
- Modify: `packages/runtime/test/tweak-lifecycle.test.ts`
- Modify: `packages/runtime/test/tweak-manager.test.ts`

**Interfaces:**
- Consumes: `ClaudeDesktopMcpService` from Task 4.
- Produces: permission-gated Main `api.mcp` and `api.claude.sessionTitles` with complete lifecycle disposal.

- [ ] **Step 1: Write failing Main API permission and disposal tests**

Extend `tweak-api.test.ts` with a complete fake service that records created and disposed leases. Assert:

- no permissions exposes neither API;
- `mcp` alone exposes only `api.mcp`;
- `claude-session-title-write` alone exposes only `api.claude.sessionTitles`;
- Renderer leases expose neither API even with both manifest permissions;
- Main lease disposal revokes retained `registerServer`, `unregister`, and `setTitle` references;
- disposal remains idempotent after Tweak start throws.

- [ ] **Step 2: Run the focused API test and verify RED**

```powershell
node --import tsx --test packages/runtime/test/tweak-api.test.ts
```

Expected: FAIL because `MainTweakApiOptions` has no Desktop MCP service and the APIs are absent.

- [ ] **Step 3: Wire permission-gated leases into `createMainTweakApiLease`**

Create the two service leases only for their exact permissions. Build `claude` by merging only the Main
`sessionTitles` capability; preserve the Renderer `sessions` construction unchanged. Dispose MCP registrations and
title capability before IPC and storage.

- [ ] **Step 4: Add failing early-install and reload-order tests**

In `main.test.ts`, inject a fake Desktop service and assert `installEarly()` is invoked synchronously by the production
initializer before a fake original-entry marker runs. In lifecycle/manager tests, assert the observable registry order
for reload is revoke old registration before starting the replacement. Assert service disposal is called on app quit.

- [ ] **Step 5: Run lifecycle tests and verify RED**

```powershell
node --import tsx --test packages/runtime/test/main.test.ts packages/runtime/test/tweak-api.test.ts packages/runtime/test/tweak-lifecycle.test.ts packages/runtime/test/tweak-manager.test.ts
```

Expected: FAIL on missing service integration and ordering observations.

- [ ] **Step 6: Initialize the observer synchronously before async bootstrap**

At Runtime module initialization, after creating the logger and requiring Electron but before calling
`bootstrapRuntime`, construct the service and call its synchronous `installEarly()`. Pass that same instance through
`RuntimeBootstrapDeps` to every Main Tweak lease. The loader remains unchanged because it already requires Runtime
before the original Claude entry.

On `will-quit`, stop Tweak leases first and then dispose the shared service. Service setup errors are logged and
replaced by an unsupported no-op service; they never reject Claude's original entry load.

- [ ] **Step 7: Run lifecycle tests and Runtime build GREEN**

```powershell
node --import tsx --test packages/runtime/test/main.test.ts packages/runtime/test/tweak-api.test.ts packages/runtime/test/tweak-lifecycle.test.ts packages/runtime/test/tweak-manager.test.ts
npm run build --workspace @claude-plusplus/runtime
node --test packages/loader/test/loader.test.cjs
```

Expected: PASS and the existing loader-order test remains green.

- [ ] **Step 8: Commit Runtime integration**

```powershell
git add packages/runtime/src/main.ts packages/runtime/src/tweak-api.ts packages/runtime/test/main.test.ts packages/runtime/test/tweak-api.test.ts packages/runtime/test/tweak-lifecycle.test.ts packages/runtime/test/tweak-manager.test.ts
git commit -m "feat: expose runtime MCP APIs to Main tweaks"
```

### Task 6: Independent Session Title Tweak

**Files:**
- Create: `D:\Unity\claude-session-title\manifest.json`
- Create: `D:\Unity\claude-session-title\package.json`
- Create: `D:\Unity\claude-session-title\index.js`
- Create: `D:\Unity\claude-session-title\test\index.test.js`
- Create: `D:\Unity\claude-session-title\test\manifest.test.js`
- Create: `D:\Unity\claude-session-title\Inject-ClaudePlusPlus.ps1`
- Create: `D:\Unity\claude-session-title\Uninject-ClaudePlusPlus.ps1`
- Create: `D:\Unity\claude-session-title\scripts\TweakLink.psm1`
- Create: `D:\Unity\claude-session-title\scripts\test\TweakLink.Tests.ps1`
- Create: `D:\Unity\claude-session-title\scripts\compatibility\validate-claudeplusplus.mjs`
- Create: `D:\Unity\claude-session-title\scripts\compatibility\validate-claudeplusplus.test.mjs`
- Create: `D:\Unity\claude-session-title\README.md`
- Create: `D:\Unity\claude-session-title\README.zh-CN.md`
- Create: `D:\Unity\claude-session-title\LICENSE`

**Interfaces:**
- Consumes: Main `api.mcp` and `api.claude.sessionTitles` from Task 5.
- Produces: `mcp__claudepp_session_title__set_session_title`.

- [ ] **Step 1: Create the minimal package and failing Tweak tests**

Create `package.json` with Node's test runner and no dependencies. Write tests that load `index.js` with complete fake
Main APIs and assert:

- `start` registers exactly one server named `claudepp_session_title`;
- the tool schema has only `session_id` and `title`, both required strings;
- invoking the captured handler forwards the literal explicit ID and title to `setTitle`;
- current and other IDs are not treated differently;
- the result is MCP text content;
- `stop` unregisters once and is idempotent;
- missing either permission-scoped API makes `start` reject with Runtime `0.2.6` guidance;
- no `fs`, settings, IPC, route, or hook API is called.

Use this expected manifest literal in `manifest.test.js`:

```js
{
  id: "com.kpk.claude-session-title",
  name: "Claude Session Title",
  version: "0.1.0",
  githubRepo: "kpkhxlgy0/claude-session-title",
  minRuntime: "0.2.6",
  scope: "main",
  main: "index.js",
  permissions: ["mcp", "claude-session-title-write"]
}
```

- [ ] **Step 2: Run external Tweak tests and verify RED**

```powershell
npm test
```

Working directory: `D:\Unity\claude-session-title`.

Expected: FAIL because `index.js` and manifest behavior are not implemented.

- [ ] **Step 3: Implement the Tweak handler**

Use module-level registration state and an async Main start:

```js
async function start(api) {
  if (api.process !== "main") return;
  if (!api.mcp || !api.claude?.sessionTitles) {
    throw new Error("Claude Session Title requires Claude++ 0.2.6 or newer.");
  }
  registration = await api.mcp.registerServer({
    name: "claudepp_session_title",
    version: "0.1.0",
    tools: [{
      name: "set_session_title",
      description: "Change a Claude Desktop session title only when the user explicitly asks for it.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Target Claude Desktop session ID." },
          title: { type: "string", description: "New session title." },
        },
        required: ["session_id", "title"],
        additionalProperties: false,
      },
      async handler(input) {
        const updated = await api.claude.sessionTitles.setTitle(input.session_id, input.title);
        return {
          content: [{ type: "text", text: `Renamed session ${updated.sessionId}.` }],
        };
      },
    }],
  });
}
```

Do not include title text in the response or logs.

- [ ] **Step 4: Add junction install/uninstall and compatibility scripts**

Reuse the established `TweakLink.psm1` junction workflow from `D:\Unity\subagent-model`, changing only the Tweak ID,
display name, source path, and tests. The compatibility validator must load Claude++ SDK validation from a supplied
source root and require both new permissions plus Runtime `0.2.6`; it must not expect a Renderer settings page.

- [ ] **Step 5: Add focused bilingual documentation**

Both READMEs must state Desktop-only scope, explicit two-argument tool contract, ability to rename current and other
known sessions, title persistence behavior, no MCP configuration writes, exact minimum Runtime, private-version
compatibility behavior, and install/uninstall commands.

- [ ] **Step 6: Run all external Tweak tests GREEN**

```powershell
npm test
pwsh -NoProfile -File scripts/test/TweakLink.Tests.ps1
```

Expected: PASS. Confirm `Get-ChildItem -Recurse` shows no generated lock file, config file, or build output.

- [ ] **Step 7: Record the external Tweak checkpoint without creating Git metadata**

```powershell
Get-ChildItem -LiteralPath 'D:\Unity\claude-session-title' -Recurse | Select-Object FullName
```

Expected: only the files listed by this task. Do not run `git init`.

### Task 7: Authoring docs and 0.2.6 release metadata

**Files:**
- Modify: `docs/tweak-authoring.md`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/0.2.6.md`
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
- Modify: `test/repository-shape.test.mjs`

**Interfaces:**
- Documents: the Task 1 SDK surface and Task 4 compatibility/lifecycle semantics.
- Produces: consistent Claude++ release version `0.2.6` for the Task 6 `minRuntime` gate.

- [ ] **Step 1: Write failing repository version expectations**

Change `repository-shape.test.mjs` and existing version-specific installer/runtime tests to expect literal `0.2.6`.

- [ ] **Step 2: Run version tests and verify RED**

```powershell
node --import tsx --test test/repository-shape.test.mjs packages/installer/test/commands.test.ts packages/runtime/test/update-service.test.ts
```

Expected: FAIL because production metadata still reports `0.2.5`.

- [ ] **Step 3: Apply the mechanical 0.2.6 version update**

Update every file in this task's list and regenerate only the lockfile metadata through the normal npm workspace
command if hand edits would leave inconsistent package entries. Do not change dependency versions.

- [ ] **Step 4: Document the APIs and approved divergence**

Add runnable Main Tweak examples for `api.mcp.registerServer` and `api.claude.sessionTitles.setTitle`. Document:

- both permissions are Main-only;
- handler/schema immutability for one Desktop process;
- registration lease cleanup;
- Desktop-only private build support and fail-closed behavior;
- no config writes and normal title persistence;
- Main Tweak permissions are capability declarations, not an OS sandbox.

Release notes and changelog must link to the independent `claude-session-title` Tweak without claiming terminal CLI
support.

- [ ] **Step 5: Run version and documentation-adjacent tests GREEN**

```powershell
node --import tsx --test test/repository-shape.test.mjs packages/installer/test/commands.test.ts packages/runtime/test/update-service.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit docs and release metadata**

```powershell
git add CHANGELOG.md docs package.json package-lock.json packages scripts test/repository-shape.test.mjs
git commit -m "release: prepare Claude++ 0.2.6"
```

Review `git status --short` before committing so `test-orange-cat.png` remains untracked.

### Task 8: Full verification and controlled Desktop validation

**Files:**
- Modify only if a failing test exposes a defect: the directly responsible production file and its existing failing-test file.
- Do not mutate Claude MCP/settings configuration during verification.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: automated and runtime evidence for release handoff.

- [ ] **Step 1: Run focused core tests**

```powershell
node --import tsx --test packages/sdk/test/manifest-validation.test.ts packages/runtime/test/tweak-mcp-registry.test.ts packages/runtime/test/claude-desktop-mcp-compat.test.ts packages/runtime/test/claude-desktop-mcp-service.test.ts packages/runtime/test/tweak-api.test.ts packages/runtime/test/main.test.ts packages/runtime/test/tweak-lifecycle.test.ts packages/runtime/test/tweak-manager.test.ts packages/loader/test/loader.test.cjs
```

Expected: PASS with no warnings.

- [ ] **Step 2: Run complete Claude++ verification**

```powershell
npm test
npm run package:windows
pwsh -File scripts/test-windows-package.ps1
```

Expected: PASS and package `dist\claude-plusplus-0.2.6-win-x64.zip` exists.

- [ ] **Step 3: Run complete external Tweak verification**

```powershell
npm test
pwsh -NoProfile -File scripts/test/TweakLink.Tests.ps1
```

Working directory: `D:\Unity\claude-session-title`.

Expected: PASS.

- [ ] **Step 4: Verify the installed Desktop bundle against the adapter**

Using the existing `@electron/asar` dependency read-only, calculate all four bundled hashes from the installed Claude
Desktop `1.26832.0` ASAR and compare them to the spec literals. Assert the coordinator, SDK helper, schema converter,
and `claudeCodeSessionManager` shapes before installing the test build.

**Task 8 external-update ruling/evidence outcome:** The `1.26832.0` text above remains the initial verification target.
After Runtime 0.2.6 was built, the live Desktop package was externally updated to Windows MSIX `1.32885.1.0`; the
running managed mirror reports app version `1.32885.1`. Read-only mapping confirmed a second exact set of four module
basenames, SHA-256 hashes, and export slots, while the Task 4 service contracts remained compatible. The controller
therefore ruled that `1.32885.1` be added as a second exact-build adapter record, with table-driven compatibility tests
covering both records and exact rejection of `1.32885.1.0`. This ruling does not authorize semver normalization,
fuzzy matching, a fallback record, a `ClaudeDesktopMcpService` change, or any public SDK API change.

**Task 8 live-smoke correction:** The controlled `1.32885.1` smoke test later proved that the UUID Claude exposes in
the conversation is the session record's `cliSessionId`, while the exported Desktop manager keys `sessions`,
`getSession`, and `updateSession` by a distinct `local_*` session ID. This runtime evidence supersedes only the
earlier “no `ClaudeDesktopMcpService` change” conclusion above. Keep the public two-argument API unchanged; the title
service must try the explicit ID directly, then resolve an exact `cliSessionId` match from the manager's existing
session map, reject ambiguous matches, and perform update/read-back with the resolved Desktop key through the manager
lookup contract. A regression test must fail against the direct-lookup-only implementation and assert the exact
lower-level `local_*` update target.

**Superseded after installed testing:** the private-value scan above also failed against the live manager despite the
persisted alias. Corrective Task 9 below replaces that boundary and extends the public API with optional caller
context; the required MCP tool arguments remain unchanged.

- [ ] **Step 5: Capture configuration baselines**

Record SHA-256 or an explicit missing marker for:

```text
%USERPROFILE%\.claude.json
<test-project>\.mcp.json
%USERPROFILE%\.claude\settings.json
```

Do not create a missing file merely to hash it.

- [ ] **Step 6: Install the built Runtime and junction the Tweak**

Run the packaged Claude++ install path, then execute `D:\Unity\claude-session-title\Inject-ClaudePlusPlus.ps1`. Fully
restart Claude Desktop so the early module observer loads before the official entry.

- [ ] **Step 7: Validate session behavior**

In controlled Desktop Code sessions, verify:

1. the MCP tool is listed in a new session;
2. the current session's displayed ID can rename itself;
3. a second session can rename itself and the first session;
4. an idle, warm-resumed, and archived session can be renamed;
5. a manually named session is overwritten because the update is user-sourced;
6. unknown ID and a 201-character title return errors;
7. Tweak disable removes the tool, and hot re-enable restores it after the current turn boundary when necessary;
8. a Desktop restart preserves the title.

- [ ] **Step 8: Prove no configuration injection occurred**

Recalculate the three configuration baselines and compare exact hashes/missing markers. Inspect the Claude child command
line and confirm Claude++ did not append its own external `--mcp-config`. Normal Desktop-provided MCP arguments are not
a failure.

- [ ] **Step 9: Review final diffs and working trees**

```powershell
git diff --check
git status --short
```

Expected in `D:\Unity\claude-plusplus`: only intentional committed changes plus the untouched untracked
`test-orange-cat.png`. Review every file under `D:\Unity\claude-session-title` and confirm no Claude configuration,
temporary logs, package archives, or secrets are present.

## Corrective Task 9: Caller-bound CLI UUID routing (0.2.7)

The first installed `set_session_title` test exposed a second session identity: Claude returned its Claude Code UUID,
but Desktop's title manager required the `local_*` key. Runtime 0.2.6 attempted to reverse-map private
`manager.sessions` values. The exact UUID-to-local mapping existed in persisted state and Desktop logs before the tool
call, yet that private-value scan returned no match in the installed Runtime.

The user approved replacing that lookup boundary while retaining the required two-argument tool and explicit
cross-session targeting. This is an additional approved Codex++ divergence: Codex++ has no in-process handler context
or Desktop/CLI identity bridge.

- Add an optional caller context to `ClaudeSessionTitlesApi.setTitle`.
- Preserve exact Desktop-key precedence, then read `getSession(callerSessionId)` and revalidate its CLI UUID against
  the explicit target before using the bound `local_*` key.
- Preserve other explicit CLI UUID targets by enumerating known keys and comparing public `getSession(...)` snapshots;
  keep zero/multiple matches fail-closed.
- Update Claude Session Title to `0.1.1`, forward the unchanged handler context, and require Runtime `0.2.7`.
- Verify strict RED/GREEN tests for the live private-value/snapshot mismatch, caller binding, other-session lookup,
  direct-key precedence, ambiguity, lifecycle, full builds, Windows packaging, and unchanged MCP/settings config.

## Corrective Task 10: Bind the actual 1.32885.1 CCD manager (0.2.8)

Installed Runtime `0.2.7` and Claude Session Title `0.1.1` were verified current in a newly restarted Claude Desktop
`1.32885.1` process. The MCP tool was present, but the displayed Claude Code UUID failed. A second diagnostic call
using the persisted Desktop key `local_bd418e1d-8ce5-4e13-a537-a5acbf968c94` also returned “session not found.” The
persisted session record and Desktop log both mapped that key to the requested UUID before the calls. This rules out
the UUID alias algorithm and proves that the title API was reading a manager that did not own the live Code session.

Read-only bundle mapping found that the compatibility record's `index2.chunk-Doi9IfNA.js` export `n` is a similarly
shaped cowork manager. The actual CCD singleton is `index.chunk-DDK-8_aa.js` export `claudeCodeSessionManager`, with
SHA-256 `88635924c6c13ea2b18af186af877d86c720438c39f1fa0fac23cbc776329b68`.

- Replace only the `1.32885.1` CCD manager module, hash, and export in the exact-build compatibility record.
- Add a regression test that distinguishes the named CCD export from the old cowork export while preserving the
  existing hash-, version-, and shape-locked fail-closed behavior.
- Release the corrected binding as Claude++ `0.2.8`.
- Keep Claude Session Title at `0.1.1`; its required MCP arguments remain `session_id` and `title`.
- Keep scope limited to Claude Desktop and continue injecting in memory without writing MCP configuration.
