import type { TweakLogger } from "@claude-plusplus/sdk";

export interface RendererLogBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export function createRendererLogger(bridge: RendererLogBridge): TweakLogger {
  const write = (level: "debug" | "info" | "warn" | "error", args: unknown[]) => {
    const message = formatLogArgs(args);
    try {
      void bridge.invoke("claudepp:renderer-log", level, message).catch((error) => {
        console.error("[Claude++] Renderer log IPC failed", error);
      });
    } catch (error) {
      console.error("[Claude++] Renderer log IPC failed", error);
    }
    const consoleLevel = level === "debug" ? "debug" : level;
    console[consoleLevel]("[Claude++]", ...args);
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

function formatLogArgs(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
}
