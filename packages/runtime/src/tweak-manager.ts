import chokidar from "chokidar";
import type { RunnableTweak } from "./tweak-lifecycle.js";

const RELOAD_DEBOUNCE_MS = 250;

export interface TweakManagerDeps {
  stopMainTweaks(): Promise<void>;
  clearMainModuleCache(): void;
  discoverMainTweaks(): RunnableTweak[];
  startMainTweaks(tweaks: RunnableTweak[]): Promise<void>;
  broadcastRendererReload(reason: string): void;
  log(message: string): void;
}

export interface TweakWatchOptions {
  ignoreInitial: boolean;
  awaitWriteFinish: { stabilityThreshold: number; pollInterval: number };
  ignored(path: string): boolean;
}

export interface TweakWatcher {
  on(
    event: "all" | "error",
    listener: ((event: string, path: string) => void) | ((error: unknown) => void),
  ): TweakWatcher;
  close(): Promise<void>;
}

export interface TweakManagerOptions {
  watchFactory(root: string, options: TweakWatchOptions): TweakWatcher;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultOptions: TweakManagerOptions = {
  watchFactory(root, options) {
    return chokidar.watch(root, options) as unknown as TweakWatcher;
  },
  setTimer(callback, delay) {
    return setTimeout(callback, delay);
  },
  clearTimer(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class TweakManager {
  private reloadQueue = Promise.resolve();

  public constructor(
    private readonly deps: TweakManagerDeps,
    private readonly options: TweakManagerOptions = defaultOptions,
  ) {}

  public reload(reason: string): Promise<void> {
    const run = async (): Promise<void> => {
      this.deps.log(`reloading Tweaks (${reason})`);
      await this.deps.stopMainTweaks();
      this.deps.clearMainModuleCache();
      const tweaks = this.deps.discoverMainTweaks();
      await this.deps.startMainTweaks(tweaks);
      this.deps.broadcastRendererReload(reason);
    };
    this.reloadQueue = this.reloadQueue.then(run, run);
    return this.reloadQueue;
  }

  public watch(tweaksRoot: string): () => Promise<void> {
    let timer: unknown;
    const watchOptions: TweakWatchOptions = {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      ignored: isIgnoredTweakPath,
    };
    const watcher = this.options.watchFactory(tweaksRoot, watchOptions);
    const schedule = (event: string, path: string): void => {
      if (watchOptions.ignored(path)) return;
      if (timer !== undefined) this.options.clearTimer(timer);
      timer = this.options.setTimer(() => {
        timer = undefined;
        void this.reload(`${event} ${path}`).catch((error) => {
          this.deps.log(`Tweak reload failed: ${errorMessage(error)}`);
        });
      }, RELOAD_DEBOUNCE_MS);
    };
    watcher.on("all", schedule);
    watcher.on("error", (error: unknown) => {
      this.deps.log(`Tweak watcher failed: ${errorMessage(error)}`);
    });
    return async () => {
      if (timer !== undefined) {
        this.options.clearTimer(timer);
        timer = undefined;
      }
      await watcher.close();
    };
  }
}

function isIgnoredTweakPath(path: string): boolean {
  return /(^|[\\/])node_modules([\\/]|$)/.test(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
