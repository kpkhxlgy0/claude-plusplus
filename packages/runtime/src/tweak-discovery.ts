import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  validateTweakManifest,
  type TweakManifest,
} from "@claude-plusplus/sdk";
import { CLAUDE_PLUSPLUS_VERSION, compareVersions } from "./version.js";

export interface DiscoveredTweak {
  dir: string;
  entry: string;
  manifest: TweakManifest;
}

export interface TweakCandidate extends DiscoveredTweak {
  entryExists: boolean;
  compatible: boolean;
  issue?: string;
}

export type TweakProcess = "renderer" | "main";

export function discoverTweaks(
  tweaksRoot: string,
  process: TweakProcess,
  onIssue: (message: string) => void = () => {},
  runtimeVersion = CLAUDE_PLUSPLUS_VERSION,
): DiscoveredTweak[] {
  if (!existsSync(tweaksRoot)) return [];
  const discovered: DiscoveredTweak[] = [];

  for (const name of readdirSync(tweaksRoot).sort()) {
    const dir = join(tweaksRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const candidate = readTweakCandidate(dir, runtimeVersion, onIssue);
      if (!candidate?.compatible || !candidate.entryExists) continue;
      const { manifest, entry } = candidate;
      if (!matchesProcess(manifest.scope, process)) continue;
      discovered.push({ dir, entry, manifest });
    } catch (error) {
      onIssue(`${name}: ${errorMessage(error)}`);
    }
  }

  return discovered;
}

export function readTweakCandidate(
  dir: string,
  runtimeVersion = CLAUDE_PLUSPLUS_VERSION,
  onIssue: (message: string) => void = () => {},
): TweakCandidate | null {
  const name = dir.split(/[\\/]/).pop() ?? dir;
  try {
    const manifestPath = join(dir, "manifest.json");
    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    const validation = validateTweakManifest(rawManifest);
    if (!validation.ok) {
      onIssue(`${name}: ${validation.errors.map((issue) => issue.message).join("; ")}`);
      return null;
    }
    const manifest = rawManifest as TweakManifest;
    const entry = resolveEntryPath(dir, manifest.main);
    const entryExists = existsSync(entry);
    const compatible = !manifest.minRuntime || compareVersions(runtimeVersion, manifest.minRuntime) >= 0;
    let issue: string | undefined;
    if (!compatible) {
      issue = `${manifest.id}: requires Claude++ ${manifest.minRuntime}; current runtime is ${runtimeVersion}`;
    } else if (!entryExists) {
      issue = `${manifest.id}: Tweak entry file is missing`;
    }
    if (issue) onIssue(issue);
    return {
      dir,
      entry,
      manifest,
      entryExists,
      compatible,
      ...(issue ? { issue } : {}),
    };
  } catch (error) {
    onIssue(`${name}: ${errorMessage(error)}`);
    return null;
  }
}

function matchesProcess(scope: TweakManifest["scope"], process: TweakProcess): boolean {
  const effectiveScope = scope ?? "both";
  return effectiveScope === "both" || effectiveScope === process;
}

function resolveEntryPath(dir: string, explicit?: string): string {
  if (explicit) return join(dir, explicit);
  for (const name of ["index.js", "index.cjs", "index.mjs"]) {
    const entry = join(dir, name);
    if (existsSync(entry)) return entry;
  }
  return join(dir, "index.js");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
