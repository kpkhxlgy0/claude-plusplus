import type { Tweak, TweakApi, TweakManifest } from "@claude-plusplus/sdk";

export interface RunnableTweak {
  manifest: TweakManifest;
  tweak: Tweak;
}

export interface TweakApiLease {
  api: TweakApi;
  dispose(): void | Promise<void>;
}

interface StartedTweak extends RunnableTweak {
  lease: TweakApiLease;
}

export class TweakLifecycle {
  private readonly started = new Map<string, StartedTweak>();

  public constructor(private readonly onError: (message: string) => void) {}

  public async startAll(
    tweaks: readonly RunnableTweak[],
    apiFactory: (manifest: TweakManifest) => TweakApiLease,
  ): Promise<void> {
    for (const item of tweaks) {
      if (this.started.has(item.manifest.id)) continue;
      let lease: TweakApiLease | undefined;
      try {
        lease = apiFactory(item.manifest);
        await item.tweak.start(lease.api);
        this.started.set(item.manifest.id, { ...item, lease });
      } catch (error) {
        this.onError(`${item.manifest.id} failed to start: ${errorMessage(error)}`);
        if (lease) await this.disposeLease(item.manifest.id, lease);
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
    const items = [...this.started.values()].reverse();
    this.started.clear();
    for (const item of items) {
      try {
        await item.tweak.stop?.();
      } catch (error) {
        this.onError(`${item.manifest.id} failed to stop: ${errorMessage(error)}`);
      }
      await this.disposeLease(item.manifest.id, item.lease);
    }
  }

  private async disposeLease(id: string, lease: TweakApiLease): Promise<void> {
    try {
      await lease.dispose();
    } catch (error) {
      this.onError(`${id} failed to dispose: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
