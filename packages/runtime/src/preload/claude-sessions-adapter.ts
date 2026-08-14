import type { ClaudeSessionsApi } from "@claude-plusplus/sdk";
import type { RendererTweakIpcBridge } from "../tweak-ipc.js";

export interface ClaudeSessionsApiLease {
  api: ClaudeSessionsApi;
  dispose(): void;
}

const resolveSessionFileChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_resolveSessionFile";
const getSessionChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getSession";

export function createClaudeSessionsApiLease(bridge: RendererTweakIpcBridge): ClaudeSessionsApiLease {
  let disposed = false;
  const assertActive = (): void => {
    if (disposed) throw new Error("Claude Sessions API lease is disposed");
  };
  return {
    api: {
      async resolveFile(sessionId, filePath): Promise<string | null> {
        assertActive();
        const result = await bridge.invoke(resolveSessionFileChannel, sessionId, filePath);
        if (result !== null && typeof result !== "string") {
          throw new Error("Claude resolveSessionFile returned an invalid result");
        }
        return result;
      },
      async getWorkspaceRoot(sessionId): Promise<string | null> {
        assertActive();
        const result = await bridge.invoke(getSessionChannel, sessionId);
        if (result === null) return null;
        if (!isRecord(result)) {
          throw new Error("Claude getSession returned an invalid result");
        }
        const root = nonEmptyString(result.worktreePath) ?? nonEmptyString(result.cwd);
        if (root === null) return null;
        if (!isAbsolutePath(root)) {
          throw new Error("Claude getSession returned an invalid workspace root");
        }
        return root;
      },
    },
    dispose(): void {
      disposed = true;
    },
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || value.startsWith("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
