import type { Tweak, TweakApi, TweakManifest } from "@claude-plusplus/sdk";

export interface RunnableTweak {
  manifest: TweakManifest;
  tweak: Tweak;
}

export interface TweakApiLease {
  api: TweakApi;
  dispose(): void | Promise<void>;
  disposeForQuit?(): void | Promise<void>;
}

interface StartedTweak extends RunnableTweak {
  lease: TweakApiLease;
  stopPromise?: Promise<void>;
  disposalPromise?: Promise<void>;
}

export class TweakLifecycle {
  private readonly started = new Map<string, StartedTweak>();
  private readonly stopping = new Set<StartedTweak>();
  private quitCleanupStarted = false;

  public constructor(private readonly onError: (message: string) => void) {}

  public async startAll(
    tweaks: readonly RunnableTweak[],
    apiFactory: (manifest: TweakManifest) => TweakApiLease,
  ): Promise<void> {
    for (const item of tweaks) {
      if (this.quitCleanupStarted) return;
      if (this.started.has(item.manifest.id)) continue;
      let started: StartedTweak | undefined;
      try {
        const lease = apiFactory(item.manifest);
        started = { ...item, lease };
        this.started.set(item.manifest.id, started);
        await item.tweak.start(lease.api);
        if (this.quitCleanupStarted) this.stopItemForQuit(started);
      } catch (error) {
        if (started && this.started.get(item.manifest.id) === started) {
          this.started.delete(item.manifest.id);
        }
        this.onError(`${item.manifest.id} failed to start: ${errorMessage(error)}`);
        if (started) {
          if (this.quitCleanupStarted) this.stopItemForQuit(started);
          else await this.disposeLease(started);
        }
      }
    }
  }

  public async reloadAll(
    tweaks: readonly RunnableTweak[],
    apiFactory: (manifest: TweakManifest) => TweakApiLease,
  ): Promise<void> {
    await this.stopAll();
    await this.startAll(tweaks, apiFactory);
  }

  public async stopAll(): Promise<void> {
    if (this.quitCleanupStarted) return;
    const items = [...this.started.values()].reverse();
    this.started.clear();
    for (const item of items) this.stopping.add(item);
    for (const item of items) {
      try {
        await this.stopTweak(item);
        await this.disposeLease(item);
      } finally {
        this.stopping.delete(item);
      }
    }
  }

  public stopAllForQuit(): void {
    if (this.quitCleanupStarted) return;
    this.quitCleanupStarted = true;
    const items = [
      ...this.stopping,
      ...[...this.started.values()].reverse(),
    ];
    this.started.clear();
    for (const item of new Set(items)) this.stopItemForQuit(item);
  }

  private stopItemForQuit(item: StartedTweak): void {
    void this.stopTweak(item);
    if (item.lease.disposeForQuit) {
      try {
        const result = item.lease.disposeForQuit();
        void Promise.resolve(result).catch((error) => {
          this.onError(`${item.manifest.id} failed to dispose during quit: ${errorMessage(error)}`);
        });
      } catch (error) {
        this.onError(`${item.manifest.id} failed to dispose during quit: ${errorMessage(error)}`);
      }
      return;
    }
    void this.disposeLease(item);
  }

  private stopTweak(item: StartedTweak): Promise<void> {
    item.stopPromise ??= this.startCleanup(
      () => item.tweak.stop?.(),
      (error) => `${item.manifest.id} failed to stop: ${errorMessage(error)}`,
    );
    return item.stopPromise;
  }

  private disposeLease(item: StartedTweak): Promise<void> {
    item.disposalPromise ??= this.startCleanup(
      () => item.lease.dispose(),
      (error) => `${item.manifest.id} failed to dispose: ${errorMessage(error)}`,
    );
    return item.disposalPromise;
  }

  private startCleanup(
    cleanup: () => void | Promise<void>,
    message: (error: unknown) => string,
  ): Promise<void> {
    try {
      return Promise.resolve(cleanup()).catch((error) => {
        this.onError(message(error));
      });
    } catch (error) {
      this.onError(message(error));
      return Promise.resolve();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
