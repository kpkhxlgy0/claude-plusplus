import type { TweakManifest } from "@claude-plusplus/sdk";
import { resolve } from "node:path";
import {
  mutateRuntimeConfigAdvisory,
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

export interface ReleaseTimerHandle {
  unref?(): void;
}

export interface ReleaseTimer {
  set(callback: () => void, delay: number): ReleaseTimerHandle;
  clear(handle: ReleaseTimerHandle): void;
}

const defaultReleaseTimer: ReleaseTimer = {
  set: (callback, delay) => setTimeout(callback, delay) as ReleaseTimerHandle,
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TweakUpdateCheckerDeps {
  request?: ReleaseRequest;
  now?: () => Date;
  timer?: ReleaseTimer;
  createAbortController?: () => AbortController;
  persist?: typeof mutateRuntimeConfigAdvisory;
  onIssue?: (message: string) => void;
}

export interface TweakUpdateChecker {
  ensure(options: EnsureTweakUpdateCheckOptions): Promise<TweakUpdateCheck>;
}

export interface EnsureTweakUpdateCheckOptions {
  configFile: string;
  manifest: TweakManifest;
}

export function tweakUpdateIdentity(configFile: string, manifest: TweakManifest): string {
  return [resolve(configFile), manifest.id, manifest.githubRepo, manifest.version].join("\u0000");
}

function isFreshMatchingCheck(
  cached: TweakUpdateCheck | undefined,
  manifest: TweakManifest,
  now: Date,
): cached is TweakUpdateCheck {
  return !!cached &&
    cached.repo === manifest.githubRepo &&
    cached.currentVersion === manifest.version &&
    now.getTime() - Date.parse(cached.checkedAt) < TWEAK_UPDATE_INTERVAL_MS;
}

export async function checkTweakRelease(
  tweak: { manifest: TweakManifest },
  request: ReleaseRequest = fetch,
  now = new Date(),
  timer: ReleaseTimer = defaultReleaseTimer,
  createAbortController: () => AbortController = () => new AbortController(),
): Promise<TweakUpdateCheck> {
  const { manifest } = tweak;
  const release = await fetchLatestRelease(
    manifest.githubRepo,
    manifest.version,
    request,
    timer,
    createAbortController,
  );
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

export function createTweakUpdateChecker(
  deps: TweakUpdateCheckerDeps = {},
): TweakUpdateChecker {
  const inFlight = new Map<string, Promise<TweakUpdateCheck>>();
  return {
    ensure(options) {
      const now = (deps.now ?? (() => new Date()))();
      const cached = readRuntimeConfig(options.configFile)
        .tweakUpdateChecks[options.manifest.id];
      if (isFreshMatchingCheck(cached, options.manifest, now)) return Promise.resolve(cached);

      const identity = tweakUpdateIdentity(options.configFile, options.manifest);
      const active = inFlight.get(identity);
      if (active) return active;
      const request = checkTweakRelease(
        { manifest: options.manifest },
        deps.request ?? fetch,
        now,
        deps.timer ?? defaultReleaseTimer,
        deps.createAbortController ?? (() => new AbortController()),
      ).then((check) => {
        const result = (deps.persist ?? mutateRuntimeConfigAdvisory)(
          options.configFile,
          (config) => {
            config.tweakUpdateChecks[options.manifest.id] = check;
          },
        );
        if (result.status !== "persisted") {
          deps.onIssue?.(`Tweak update cache ${result.status}: ${options.manifest.id}`);
        }
        return check;
      });
      const pending: Promise<TweakUpdateCheck> = request.finally(() => {
        if (inFlight.get(identity) === pending) inFlight.delete(identity);
      });
      inFlight.set(identity, pending);
      return pending;
    },
  };
}

const productionTweakUpdateChecker = createTweakUpdateChecker();

export function ensureTweakUpdateCheck(
  options: EnsureTweakUpdateCheckOptions,
): Promise<TweakUpdateCheck> {
  return productionTweakUpdateChecker.ensure(options);
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
  timer: ReleaseTimer,
  createAbortController: () => AbortController,
): Promise<ReleaseResult> {
  const controller = createAbortController();
  const timeout = timer.set(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    timer.clear(timeout);
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
