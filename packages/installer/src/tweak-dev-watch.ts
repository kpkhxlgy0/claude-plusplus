import { watch } from "node:fs";
import { relative, resolve } from "node:path";
import type { ClaudePlusPlusPaths } from "./paths.js";
import {
  assertWindowsTweakDevelopment,
  writeDevReloadMarker,
} from "./tweak-dev-link.js";
import { requireValidTweakProject } from "./tweak-project.js";
import {
  consoleTweakCommandOutput,
  type TweakCommandOutput,
} from "./tweak-output.js";

const SOURCE_VALIDATION_DEBOUNCE_MS = 100;
const IGNORED_MARKERS = new Set([
  ".claudepp-dev-reload",
  ".claudepp-safe-mode-reload",
]);

export interface DevSourceWatcher {
  on(event: "error", listener: (error: unknown) => void): DevSourceWatcher;
  close(): void;
}

export interface TweakDevWatchDependencies {
  watchFactory(
    sourceDir: string,
    options: { recursive: true },
    listener: (event: string, filename: string | Buffer | null) => void,
  ): DevSourceWatcher;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
  onSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  now(): Date;
  platform(): NodeJS.Platform;
  writeMarker(paths: ClaudePlusPlusPaths): string;
  output: TweakCommandOutput;
}

const defaultDependencies: TweakDevWatchDependencies = {
  watchFactory(sourceDir, options, listener) {
    return watch(sourceDir, options, listener) as DevSourceWatcher;
  },
  setTimer(callback, delay) {
    return setTimeout(callback, delay);
  },
  clearTimer(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
  onSignal(signal, listener) {
    process.once(signal, listener);
  },
  offSignal(signal, listener) {
    process.removeListener(signal, listener);
  },
  now() {
    return new Date();
  },
  platform() {
    return process.platform;
  },
  writeMarker(paths) {
    return writeDevReloadMarker(paths);
  },
  output: consoleTweakCommandOutput,
};

export async function watchTweakProject(
  sourceDir: string,
  paths: ClaudePlusPlusPaths,
  dependencies: Partial<TweakDevWatchDependencies> = {},
): Promise<void> {
  const watchFactory = dependencies.watchFactory ?? defaultDependencies.watchFactory;
  const setTimer = dependencies.setTimer ?? defaultDependencies.setTimer;
  const clearTimer = dependencies.clearTimer ?? defaultDependencies.clearTimer;
  const onSignal = dependencies.onSignal ?? defaultDependencies.onSignal;
  const offSignal = dependencies.offSignal ?? defaultDependencies.offSignal;
  const now = dependencies.now ?? defaultDependencies.now;
  const platform = dependencies.platform ?? defaultDependencies.platform;
  const writeMarker = dependencies.writeMarker ?? defaultDependencies.writeMarker;
  const output = dependencies.output ?? defaultDependencies.output;

  assertWindowsTweakDevelopment(platform());

  let pendingTimer: unknown;
  let finished = false;
  let generation = 0;
  const sourceListener = (_event: string, filename: string | Buffer | null): void => {
    if (finished) return;
    const normalizedFilename = filename === null ? null : String(filename);
    if (normalizedFilename !== null && isIgnoredSourcePath(normalizedFilename)) return;
    if (pendingTimer !== undefined) clearTimer(pendingTimer);
    const scheduledGeneration = ++generation;
    pendingTimer = setTimer(() => {
      if (finished || scheduledGeneration !== generation) return;
      pendingTimer = undefined;
      try {
        requireValidTweakProject(sourceDir);
        writeMarker(paths);
        const suffix = normalizedFilename === null
          ? ""
          : ` (${relative(sourceDir, resolve(sourceDir, normalizedFilename))})`;
        output.log(`valid ${formatTime(now())}${suffix}`);
      } catch (error) {
        output.error(`invalid ${errorMessage(error)}`);
      }
    }, SOURCE_VALIDATION_DEBOUNCE_MS);
  };
  const watcher = watchFactory(sourceDir, { recursive: true }, sourceListener);

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const stop = (): void => finish();
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      generation += 1;
      if (pendingTimer !== undefined) {
        clearTimer(pendingTimer);
        pendingTimer = undefined;
      }
      watcher.close();
      offSignal("SIGINT", stop);
      offSignal("SIGTERM", stop);
      if (error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Tweak source watcher failed: ${errorMessage(error)}`));
      }
    };

    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
    watcher.on("error", (error) => finish(error));
  });
}

function isIgnoredSourcePath(path: string): boolean {
  if (/(^|[\\/])node_modules([\\/]|$)/.test(path)) return true;
  const basename = path.split(/[\\/]/).at(-1);
  return basename !== undefined && IGNORED_MARKERS.has(basename);
}

function formatTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
