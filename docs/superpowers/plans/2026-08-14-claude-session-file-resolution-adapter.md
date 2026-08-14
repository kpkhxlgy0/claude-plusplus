# Claude Session File Resolution Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a permission-declaring Claude++ Renderer Tweak to resolve a Claude session-relative file reference to
its exact local path, or obtain the session workspace root for a bounded unique-file fallback, without opening
Claude's native file preview.

**Architecture:** Follow Codex++'s host-specific `api.codex` pattern with an optional `api.claude` surface, but expose
only two typed, read-only session operations. A focused Renderer adapter invokes Claude Desktop's validated
`LocalSessions.resolveSessionFile` and `LocalSessions.getSession` IPC contracts. Unity Links extracts the current
session id from the `app://localhost/epitaxy/<session-id>` route and reuses its existing Unity validation and named-pipe
transport.

**Approved Claude divergence:** Codex++ does not need a Claude session adapter. The user approved
`getWorkspaceRoot(sessionId)` in addition to direct file resolution because current Claude native file references can
contain only a basename. The method exposes only an absolute `worktreePath` or `cwd` from the selected session; it does
not expose the rest of the private session record or a generic IPC primitive. Unity Links uses the root only to scan
the bounded `Assets`, `ProjectSettings`, and `Packages` trees and accepts exactly one match.

**Tech Stack:** TypeScript, Electron Renderer preload IPC, Node.js test runner, CommonJS Claude Tweak, Windows Unity named pipe.

## Global Constraints

- Compare every host-specific API decision with Codex++ before implementation.
- Do not expose an arbitrary Claude IPC channel or generic main-world execution primitive.
- Gate the adapter behind a declared `claude-sessions` permission.
- Keep failure behavior recoverable: if the adapter or resolution is unavailable, replay Claude's original click.
- Do not commit or push until the user explicitly authorizes it.

---

### Task 1: Public Claude Sessions API

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/manifest-validation.test.ts`

**Interfaces:**
- Produces: `TweakPermission` value `"claude-sessions"`.
- Produces: optional `TweakApi.claude?: ClaudeApi`.
- Produces: `ClaudeSessionsApi.resolveFile(sessionId: string, filePath: string): Promise<string | null>`.
- Produces: `ClaudeSessionsApi.getWorkspaceRoot(sessionId: string): Promise<string | null>`.

- [ ] **Step 1: Write failing SDK tests**

Add assertions that `claude-sessions` is accepted, an unknown Claude permission is rejected, and an API fixture can supply `claude.sessions.resolveFile`.

- [ ] **Step 2: Run the SDK test and verify RED**

Run: `node --import tsx --test packages/sdk/test/manifest-validation.test.ts`

Expected: FAIL because `claude-sessions` and `TweakApi.claude` do not exist.

- [ ] **Step 3: Add the minimal SDK contract**

```ts
export interface ClaudeApi {
  sessions: ClaudeSessionsApi;
}

export interface ClaudeSessionsApi {
  resolveFile(sessionId: string, filePath: string): Promise<string | null>;
  getWorkspaceRoot(sessionId: string): Promise<string | null>;
}
```

Add `"claude-sessions"` to `VALID_TWEAK_PERMISSIONS` and add optional `claude?: ClaudeApi` to `TweakApi`.

- [ ] **Step 4: Run the SDK test and verify GREEN**

Run: `node --import tsx --test packages/sdk/test/manifest-validation.test.ts`

Expected: PASS.

### Task 2: Version-Contained Renderer Adapter

**Files:**
- Create: `packages/runtime/src/preload/claude-sessions-adapter.ts`
- Create: `packages/runtime/test/claude-sessions-adapter.test.ts`
- Modify: `packages/runtime/src/tweak-api.ts`
- Modify: `packages/runtime/test/tweak-api.test.ts`

**Interfaces:**
- Consumes: `ClaudeSessionsApi` and `claude-sessions` permission from Task 1.
- Produces: a revocable Claude Sessions API lease.
- Uses only Claude Desktop's current validated IPC methods `LocalSessions.resolveSessionFile(sessionId, filePath)` and
  `LocalSessions.getSession(sessionId)`.

- [ ] **Step 1: Write failing adapter and permission-gating tests**

Test that the adapter invokes the exact current Claude IPC channels, accepts only validated absolute-path results,
prefers `worktreePath` over `cwd`, rejects malformed host responses, remains absent without permission, is present in
Renderer leases with permission, and rejects retained calls after the lease is disposed.

- [ ] **Step 2: Run focused runtime tests and verify RED**

Run: `node --import tsx --test packages/runtime/test/claude-sessions-adapter.test.ts packages/runtime/test/tweak-api.test.ts`

Expected: FAIL because the adapter and gated `api.claude` surface do not exist.

- [ ] **Step 3: Implement the typed adapter and gate**

```ts
const RESOLVE_SESSION_FILE_CHANNEL =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_resolveSessionFile";

export function createClaudeSessionsApi(bridge: RendererTweakIpcBridge): ClaudeSessionsApi {
  return {
    async resolveFile(sessionId, filePath) {
      const value = await bridge.invoke(RESOLVE_SESSION_FILE_CHANNEL, sessionId, filePath);
      if (value !== null && typeof value !== "string") {
        throw new Error("Claude resolveSessionFile returned an invalid result");
      }
      return value;
    },
  };
}
```

Only attach `claude: { sessions: ... }` when the manifest includes `claude-sessions`. Dispose the adapter lease with
the Renderer Tweak API lease so disable, reload, and permission removal revoke retained method references.

- [ ] **Step 4: Run focused runtime tests and verify GREEN**

Run: `node --import tsx --test packages/runtime/test/claude-sessions-adapter.test.ts packages/runtime/test/tweak-api.test.ts`

Expected: PASS.

### Task 3: Unity Links Relative Native References

**Files:**
- Modify: `D:/workspace/sgproj/FilePackages/unity-links/claude-tweak/manifest.json`
- Modify: `D:/workspace/sgproj/FilePackages/unity-links/claude-tweak/index.js`
- Modify: `D:/workspace/sgproj/FilePackages/unity-links/claude-tweak/test/index.test.js`

**Interfaces:**
- Consumes: `api.claude.sessions.resolveFile(sessionId, filePath)` from Task 2.
- Produces: `parseClaudeSessionId(url)` for `app://localhost/epitaxy/<session-id>`.
- Preserves: absolute file references, web links, modifier clicks, and Claude click replay on unresolved files.
- Consumes: `api.claude.sessions.getWorkspaceRoot(sessionId)` only after direct resolution cannot produce a path.

- [ ] **Step 1: Write failing Tweak tests**

Add tests for route parsing and for basename `.cs`, `.prefab`, and `.unity` native references resolving to exact absolute paths before invoking `open-asset`. Add a failure case that replays Claude's original click when resolution returns `null`.

- [ ] **Step 2: Run the focused Tweak test and verify RED**

Run: `node --test test/index.test.js`

Expected: FAIL because relative native references are currently left to Claude.

- [ ] **Step 3: Implement minimal relative-reference resolution**

For `span[role="button"] > code` references that are not already absolute, parse the current session id, prevent the
original click, call `api.claude.sessions.resolveFile`, and validate the resulting absolute path through the existing
`parseDestination` and `hasSupportedProjectSegment` gates. If Claude cannot resolve a basename, read the session
workspace root and scan only `Assets`, `ProjectSettings`, and `Packages`; accept exactly one complete filename match.
Then invoke the existing `open-asset` path. Replay the original click on missing capability, missing session id,
ambiguous or missing matches, invalid results, or adapter failure.

- [ ] **Step 4: Run Claude Tweak tests and verify GREEN**

Run: `npm test`

Expected: all tests pass.

### Task 4: Build, Install, and Live Verification

**Files:**
- Verify only; no new source files expected.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: installed Claude++ Runtime capable of resolving native basename references.

- [ ] **Step 1: Run complete automated verification**

Run in `D:/Unity/ClaudePlusPlus`: `npm test`

Run in `D:/workspace/sgproj/FilePackages/unity-links/claude-tweak`: `npm test`

Run in `D:/workspace/sgproj/FilePackages/unity-links`: `pwsh -NoProfile -File ./scripts/tests/Run-Tests.ps1`

Expected: zero failures, followed by clean `git diff --check` in both repositories.

- [ ] **Step 2: Build and install Claude++ with Claude Desktop closed**

Build the Windows package using the repository's release command, install it with the generated `install.ps1`, and confirm the managed Runtime contains the new adapter. Do not alter the official Claude package.

- [ ] **Step 3: Verify live native references**

After Claude Desktop restarts, click one basename script reference, one Prefab reference, and one Scene reference. Success means each click reaches the existing Unity receiver, Claude's own preview does not open, and unresolved/non-Unity references retain Claude's original behavior.

- [ ] **Step 4: Review final state without committing**

Confirm Claude++ changes remain on `fix/renderer-tweak-csp`, Claude Tweak changes remain on `master`, and the Unity Links umbrella records only the dirty Claude Tweak submodule until the user authorizes commits.
