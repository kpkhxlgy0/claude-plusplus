import { readFileSync } from "node:fs";

export function resolveInstalledSourceRoot(stateFile: string, fallback: string): string {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    if ((state.schemaVersion === 1 || state.schemaVersion === 2) &&
      typeof state.sourceRoot === "string" && state.sourceRoot.trim()) return state.sourceRoot;
  } catch {}
  return fallback;
}
