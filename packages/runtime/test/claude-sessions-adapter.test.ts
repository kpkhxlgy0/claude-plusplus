import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeSessionsApiLease } from "../src/preload/claude-sessions-adapter.ts";

const resolveSessionFileChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_resolveSessionFile";
const getSessionChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getSession";
const getTranscriptChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getTranscript";

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

test("Claude Sessions adapter selects line-bearing and unnumbered references by visible occurrence", async () => {
  const invoked: unknown[][] = [];
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async (channel, ...args) => {
    invoked.push([channel, ...args]);
    return [
      {
        type: "assistant",
        message: {
          id: "resp-file-links",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result" }],
        },
      },
      {
        type: "assistant",
        message: {
          id: "resp-final",
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "[Arena.unity:88](file:///D:/workspace/sgproj/Assets/Scenes/Arena.unity#L88)",
              "[Arena.unity](file:///D:/workspace/sgproj/Assets/Scenes/Arena.unity)",
            ].join("\n"),
          }],
        },
      },
    ];
  })).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Arena.unity", 0, 2),
    "file:///D:/workspace/sgproj/Assets/Scenes/Arena.unity#L88",
  );
  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Arena.unity", 1, 2),
    "file:///D:/workspace/sgproj/Assets/Scenes/Arena.unity",
  );
  assert.deepEqual(invoked, [
    [getTranscriptChannel, "local-session-id"],
    [getTranscriptChannel, "local-session-id"],
  ]);
});

test("Claude Sessions adapter refuses an out-of-range or non-local transcript reference", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => [{
    type: "assistant",
    message: {
      id: "resp-file-links",
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "[GameEntry.cs:10](file:///D:/workspace/one/Assets/GameEntry.cs#L10)",
          "[GameEntry.cs:20](file:///D:/workspace/two/Assets/GameEntry.cs#L20)",
          "[GameEntry.cs](https://example.com/GameEntry.cs)",
        ].join("\n"),
      }],
    },
  }])).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "GameEntry.cs", 2, 2),
    null,
  );
});

test("Claude Sessions adapter counts only rendered Markdown links", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => [{
    type: "assistant",
    message: {
      id: "resp-file-links",
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "`[Boss.prefab](file:///D:/workspace/hidden-inline/Assets/Boss.prefab)`",
          "```text",
          "[Boss.prefab](file:///D:/workspace/hidden-fence/Assets/Boss.prefab)",
          "```",
          "\\[Boss.prefab](file:///D:/workspace/escaped/Assets/Boss.prefab)",
          "![Boss.prefab](file:///D:/workspace/image/Assets/Boss.prefab)",
          "[Boss.prefab](file:///D:/workspace/visible/Assets/Boss.prefab)",
        ].join("\n"),
      }],
    },
  }])).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Boss.prefab", 0, 1),
    "file:///D:/workspace/visible/Assets/Boss.prefab",
  );
  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Boss.prefab", 1, 1),
    null,
  );
});

test("Claude Sessions adapter handles indented, quoted, and escaped-backtick Markdown", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => [{
    type: "assistant",
    message: {
      id: "resp-file-links",
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "    [Boss.prefab](file:///D:/workspace/hidden-indent/Assets/Boss.prefab)",
          "> ```text",
          "> [Boss.prefab](file:///D:/workspace/hidden-quote-fence/Assets/Boss.prefab)",
          "> ```",
          "\\`[Boss.prefab](file:///D:/workspace/visible-escaped-backtick/Assets/Boss.prefab)`",
          "[Boss.prefab](file:///D:/workspace/visible/Assets/Boss.prefab)",
        ].join("\n"),
      }],
    },
  }])).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Boss.prefab", 0, 2),
    "file:///D:/workspace/visible-escaped-backtick/Assets/Boss.prefab",
  );
  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Boss.prefab", 1, 2),
    "file:///D:/workspace/visible/Assets/Boss.prefab",
  );
});

test("Claude Sessions adapter refuses mismatched transcript and DOM occurrence counts", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => [{
    type: "assistant",
    message: {
      id: "resp-file-links",
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "[Boss.prefab](file:///D:/workspace/one/Assets/Boss.prefab)",
          "[Boss.prefab](file:///D:/workspace/two/Assets/Boss.prefab)",
        ].join("\n"),
      }],
    },
  }])).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Boss.prefab", 0, 1),
    null,
  );
});

test("Claude Sessions adapter stops reference recovery at the next real user turn", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => [
    {
      type: "assistant",
      message: {
        id: "resp-file-links",
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result" }],
      },
    },
    {
      type: "assistant",
      message: {
        id: "resp-final",
        role: "assistant",
        content: [{
          type: "text",
          text: "[Arena.unity](file:///D:/workspace/current/Assets/Arena.unity)",
        }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Continue" }] },
    },
    {
      type: "assistant",
      message: {
        id: "resp-next",
        role: "assistant",
        content: [{
          type: "text",
          text: "[Arena.unity](file:///D:/workspace/next/Assets/Arena.unity)",
        }],
      },
    },
  ])).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Arena.unity", 0, 1),
    "file:///D:/workspace/current/Assets/Arena.unity",
  );
  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Arena.unity", 1, 1),
    null,
  );
});

test("Claude Sessions adapter rejects UNC-like file URLs", async () => {
  const api = createClaudeSessionsApiLease(rendererIpcBridge(async () => [{
    type: "assistant",
    message: {
      id: "resp-file-links",
      role: "assistant",
      content: [{
        type: "text",
        text: "[Boss.prefab](file:////server/share/Assets/Boss.prefab)",
      }],
    },
  }])).api;

  assert.equal(
    await api.resolveReference("local-session-id", "resp-file-links", "Boss.prefab", 0, 1),
    null,
  );
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
