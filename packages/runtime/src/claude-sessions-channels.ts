import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ClaudeSessionsChannels {
  resolveSessionFile: string;
  getSession: string;
  getTranscript: string;
}

export type ClaudeSessionsChannelDiscovery = ClaudeSessionsChannels | { error: string };

const methods = ["resolveSessionFile", "getSession", "getTranscript"] as const;
const channelPrefix = /^\$eipc_message\$_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_\$_claude\.web_\$_$/i;

export function discoverClaudeSessionsChannels(hostPreloadPath: string): ClaudeSessionsChannelDiscovery {
  let source: string;
  try {
    source = readFileSync(hostPreloadPath, "utf8");
  } catch {
    return { error: "Claude LocalSessions channels are unavailable: host preload not found or unreadable" };
  }

  const candidates = new Set<string>();
  const declarations = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*["'](\$eipc_message\$_[^"']+)["']/g;
  for (const match of source.matchAll(declarations)) {
    const [, variable, prefix] = match;
    if (!channelPrefix.test(prefix)) continue;
    const escapedVariable = variable.replace(/\$/g, "\\$");
    if (methods.every((method) => new RegExp(
      `\\bipcRenderer\\.invoke\\(\\s*${escapedVariable}\\s*\\+\\s*["']LocalSessions_\\$_${method}["']`,
    ).test(source))) candidates.add(prefix);
  }

  if (candidates.size !== 1) {
    return { error: `Claude LocalSessions channels are unavailable: ${candidates.size ? "ambiguous" : "missing"} host mapping` };
  }
  const prefix = [...candidates][0];
  return {
    resolveSessionFile: `${prefix}LocalSessions_$_resolveSessionFile`,
    getSession: `${prefix}LocalSessions_$_getSession`,
    getTranscript: `${prefix}LocalSessions_$_getTranscript`,
  };
}

export function activeClaudeHostPreloadPath(resourcesPath = process.resourcesPath): string {
  return resolve(resourcesPath, "app.asar", ".vite", "build", "mainView.js");
}
