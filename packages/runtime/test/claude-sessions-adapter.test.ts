import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeSessionsApiLease } from "../src/preload/claude-sessions-adapter.ts";

const resolveSessionFileChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_resolveSessionFile";
const getSessionChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getSession";

test("Claude Sessions adapter resolves through Claude's focused IPC channel", async () => {
  const invoked: unknown[][] = [];
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async (channel, ...args) => {
    invoked.push([channel, ...args]);
    return "D:\\workspace\\sgproj\\Assets\\GameEntry.cs";
  })).api;

  assert.equal(
    await api.resolveFile("local-session-id", "GameEntry.cs"),
    "D:\\workspace\\sgproj\\Assets\\GameEntry.cs",
  );
  assert.deepEqual(invoked, [[resolveSessionFileChannel, "local-session-id", "GameEntry.cs"]]);
});

test("Claude Sessions adapter preserves a missing-file result", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => null)).api;
  assert.equal(await api.resolveFile("local-session-id", "Missing.prefab"), null);
});

test("Claude Sessions adapter rejects malformed host results", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => ({ path: "bad" }))).api;
  await assert.rejects(
    () => api.resolveFile("local-session-id", "Broken.unity"),
    /invalid result/,
  );
});

test("Claude Sessions adapter returns the session worktree before cwd", async () => {
  const invoked = [];
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async (channel, ...args) => {
    invoked.push([channel, ...args]);
    return {
      cwd: "D:\\workspace\\sgproj",
      worktreePath: "D:\\workspace\\sgproj-worktree",
    };
  })).api;

  assert.equal(
    await api.getWorkspaceRoot("local-session-id"),
    "D:\\workspace\\sgproj-worktree",
  );
  assert.deepEqual(invoked, [[getSessionChannel, "local-session-id"]]);
});

test("Claude Sessions adapter falls back to cwd and rejects invalid roots", async () => {
  const cwdApi = createClaudeSessionsApiLease(rendererIpcBridge(async () => ({
    cwd: "D:\\workspace\\sgproj",
  }))).api;
  assert.equal(await cwdApi.getWorkspaceRoot("local-session-id"), "D:\\workspace\\sgproj");

  const missingApi = createClaudeSessionsApiLease(rendererIpcBridge(async () => null)).api;
  assert.equal(await missingApi.getWorkspaceRoot("local-session-id"), null);

  const relativeApi = createClaudeSessionsApiLease(rendererIpcBridge(async () => ({ cwd: "relative" }))).api;
  await assert.rejects(
    () => relativeApi.getWorkspaceRoot("local-session-id"),
    /invalid workspace root/,
  );
});

function rendererIpcBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
) {
  return {
    on(): void {},
    removeListener(): void {},
    send(): void {},
    invoke,
  };
}
