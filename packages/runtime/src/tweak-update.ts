import type { TweakManifest } from "@claude-plusplus/sdk";
import {
  mutateRuntimeConfig,
  readRuntimeConfig,
  type TweakUpdateCheck,
} from "./config.js";
import { compareVersions } from "./version.js";

export const TWEAK_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export type ReleaseRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function checkTweakRelease(
  tweak: { manifest: TweakManifest },
  request: ReleaseRequest = fetch,
  now = new Date(),
): Promise<TweakUpdateCheck> {
  const { manifest } = tweak;
  const release = await fetchLatestRelease(manifest.githubRepo, manifest.version, request);
  const latestVersion = release.latestTag ? normalizeVersion(release.latestTag) : null;
  return {
    checkedAt: now.toISOString(),
    repo: manifest.githubRepo,
    currentVersion: manifest.version,
    latestVersion,
    latestTag: release.latestTag,
    releaseUrl: release.releaseUrl,
    updateAvailable: latestVersion
      ? compareVersions(latestVersion, normalizeVersion(manifest.version)) > 0
      : false,
    ...(release.error ? { error: release.error } : {}),
  };
}

export interface EnsureTweakUpdateCheckOptions {
  configFile: string;
  manifest: TweakManifest;
  request?: ReleaseRequest;
  now?: Date;
}

export async function ensureTweakUpdateCheck(
  options: EnsureTweakUpdateCheckOptions,
): Promise<TweakUpdateCheck> {
  const now = options.now ?? new Date();
  const config = readRuntimeConfig(options.configFile);
  const cached = config.tweakUpdateChecks[options.manifest.id];
  if (
    cached &&
    cached.repo === options.manifest.githubRepo &&
    cached.currentVersion === options.manifest.version &&
    now.getTime() - Date.parse(cached.checkedAt) < TWEAK_UPDATE_INTERVAL_MS
  ) {
    return cached;
  }
  const check = await checkTweakRelease(
    { manifest: options.manifest },
    options.request,
    now,
  );
  mutateRuntimeConfig(options.configFile, (next) => {
    next.tweakUpdateChecks[options.manifest.id] = check;
  });
  return check;
}

interface ReleaseResult {
  latestTag: string | null;
  releaseUrl: string | null;
  error?: string;
}

async function fetchLatestRelease(
  repo: string,
  currentVersion: string,
  request: ReleaseRequest,
): Promise<ReleaseResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await request(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `claude-plusplus/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { latestTag: null, releaseUrl: null, error: "no GitHub release found" };
    }
    if (!response.ok) {
      return { latestTag: null, releaseUrl: null, error: `GitHub returned ${response.status}` };
    }
    const release = await response.json() as {
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
    };
    if (release.draft || !release.tag_name) {
      return { latestTag: null, releaseUrl: null, error: "no GitHub release found" };
    }
    return {
      latestTag: release.tag_name,
      releaseUrl: release.html_url ?? `https://github.com/${repo}/releases`,
    };
  } catch (error) {
    return {
      latestTag: null,
      releaseUrl: null,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
