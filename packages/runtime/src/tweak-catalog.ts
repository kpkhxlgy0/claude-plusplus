import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig, TweakUpdateCheck } from "./config.js";
import { isTweakEnabled } from "./config.js";
import {
  readTweakCandidate,
  type TweakCandidate,
} from "./tweak-discovery.js";
import { CLAUDE_PLUSPLUS_VERSION } from "./version.js";

export interface ListedTweak extends TweakCandidate {
  enabled: boolean;
  update: TweakUpdateCheck | null;
}

export interface ListInstalledTweaksOptions {
  tweaksRoot: string;
  config: RuntimeConfig;
  runtimeVersion?: string;
  onIssue?: (message: string) => void;
}

export function listInstalledTweaks(options: ListInstalledTweaksOptions): ListedTweak[] {
  if (!existsSync(options.tweaksRoot)) return [];
  const listed: ListedTweak[] = [];
  for (const name of readdirSync(options.tweaksRoot).sort()) {
    const dir = join(options.tweaksRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const candidate = readTweakCandidate(
        dir,
        options.runtimeVersion ?? CLAUDE_PLUSPLUS_VERSION,
        options.onIssue,
      );
      if (!candidate) continue;
      const cached = options.config.tweakUpdateChecks[candidate.manifest.id];
      const update = cached &&
        cached.repo === candidate.manifest.githubRepo &&
        cached.currentVersion === candidate.manifest.version
        ? cached
        : null;
      listed.push({
        ...candidate,
        enabled: !options.config.claudePlusPlus.safeMode &&
          isTweakEnabled(options.config, candidate.manifest.id),
        update,
      });
    } catch (error) {
      options.onIssue?.(`${name}: ${errorMessage(error)}`);
    }
  }
  return listed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
