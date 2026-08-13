import type {
  SettingsHandle,
  SettingsPage,
  SettingsSection,
  Tweak,
  TweakApi,
  TweakManifest,
  TweakLogger,
} from "@claude-plusplus/sdk";
import {
  createRendererTweakApiLease,
  type RendererStorageBridge,
} from "../tweak-api.js";
import type { RendererTweakIpcBridge } from "../tweak-ipc.js";
import {
  TweakLifecycle,
  type RunnableTweak,
  type TweakApiLease,
} from "../tweak-lifecycle.js";
import type { ListedTweakView } from "../settings/types.js";

export interface RendererTweakSource {
  manifest: TweakManifest;
  source: string;
  filename: string;
}

export interface RendererTweakCatalog {
  tweaksPath: string;
  tweaks: ListedTweakView[];
}

export interface RendererTweakRuntimeOptions extends Omit<RendererTweakHostOptions, "loadTweaks"> {
  loadCatalog(): Promise<RendererTweakCatalog>;
  readTweakSource(entry: string): Promise<string>;
  publishCatalog(tweaks: ListedTweakView[], tweaksPath: string): void;
  subscribeReload(listener: () => void): () => void;
  clearSettings(): void;
}

export interface RendererTweakRuntime {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RendererTweakHostOptions {
  loadTweaks: () => Promise<RendererTweakSource[]>;
  log: TweakLogger;
  storage: RendererStorageBridge;
  ipc: RendererTweakIpcBridge;
  settings?: RendererSettingsHost;
}

export interface RendererSettingsHost {
  registerSection(tweakId: string, section: SettingsSection): SettingsHandle;
  registerPage(tweakId: string, manifest: TweakManifest, page: SettingsPage): SettingsHandle;
}

export function evaluateRendererTweak(
  source: string,
  filename: string,
  api: TweakApi,
): Tweak {
  const module = { exports: {} as unknown };
  const factory = new Function(
    "module",
    "exports",
    "console",
    "api",
    "require",
    `${source}\n//# sourceURL=${filename.replace(/[\r\n]/g, "")}`,
  );
  factory(module, module.exports, console, api, undefined);
  const value = unwrapDefault(module.exports);
  if (!isTweak(value)) throw new Error(`${filename} must export a Tweak with start(api)`);
  return value;
}

export async function startRendererTweaks(options: RendererTweakHostOptions): Promise<TweakLifecycle> {
  const lifecycle = new TweakLifecycle((message) => options.log.error(message));
  const runnable: RunnableTweak[] = [];
  const prepared = new Map<string, TweakApiLease>();
  for (const item of await options.loadTweaks()) {
    const baseLease = createRendererTweakApiLease({
      manifest: item.manifest,
      log: options.log,
      storage: options.storage,
      ipc: options.ipc,
    });
    const settingsHandles = new Set<SettingsHandle>();
    const settingsApi = createSettingsApi(item.manifest, options.settings, settingsHandles);
    const api = settingsApi ? { ...baseLease.api, settings: settingsApi } : baseLease.api;
    const lease: TweakApiLease = {
      api,
      async dispose() {
        for (const handle of [...settingsHandles].reverse()) {
          try {
            handle.unregister();
          } catch (error) {
            options.log.error(`${item.manifest.id} Settings cleanup failed: ${errorMessage(error)}`);
          }
        }
        settingsHandles.clear();
        await baseLease.dispose();
      },
    };
    try {
      if (prepared.has(item.manifest.id)) {
        throw new Error(`duplicate Tweak id: ${item.manifest.id}`);
      }
      const tweak = evaluateRendererTweak(item.source, item.filename, api);
      prepared.set(item.manifest.id, lease);
      runnable.push({ manifest: item.manifest, tweak });
    } catch (error) {
      options.log.error(`${item.manifest.id} failed to evaluate: ${errorMessage(error)}`);
      await lease.dispose();
    }
  }
  await lifecycle.startAll(runnable, (manifest) => {
    const lease = prepared.get(manifest.id);
    if (!lease) throw new Error(`Tweak API lease is missing: ${manifest.id}`);
    prepared.delete(manifest.id);
    return lease;
  });
  return lifecycle;
}

export function createRendererTweakRuntime(
  options: RendererTweakRuntimeOptions,
): RendererTweakRuntime {
  let lifecycle: TweakLifecycle | null = null;
  let inFlight: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;
  let disposed = false;

  const reconstruct = (): Promise<void> => {
    if (inFlight) return inFlight;
    const run = async (): Promise<void> => {
      if (disposed) return;
      if (lifecycle) await lifecycle.stopAll();
      lifecycle = null;
      options.clearSettings();
      const catalog = await options.loadCatalog();
      if (disposed) return;
      options.publishCatalog(catalog.tweaks, catalog.tweaksPath);
      const sources: RendererTweakSource[] = [];
      for (const tweak of catalog.tweaks) {
        if (!isRunnableRendererTweak(tweak)) continue;
        try {
          sources.push({
            manifest: tweak.manifest,
            source: await options.readTweakSource(tweak.entry),
            filename: tweak.entry,
          });
        } catch (error) {
          options.log.error(`${tweak.manifest.id} source load failed: ${errorMessage(error)}`);
        }
      }
      if (disposed) return;
      lifecycle = await startRendererTweaks({
        loadTweaks: async () => sources,
        log: options.log,
        storage: options.storage,
        ipc: options.ipc,
        ...(options.settings ? { settings: options.settings } : {}),
      });
    };
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    async start(): Promise<void> {
      if (started) return await (inFlight ?? Promise.resolve());
      started = true;
      unsubscribe = options.subscribeReload(() => {
        void reconstruct().catch((error) => {
          options.log.error(`Renderer Tweak reconstruction failed: ${errorMessage(error)}`);
        });
      });
      await reconstruct();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      await inFlight;
      await lifecycle?.stopAll();
      lifecycle = null;
      options.clearSettings();
    },
  };
}

function createSettingsApi(
  manifest: TweakManifest,
  host: RendererSettingsHost | undefined,
  handles: Set<SettingsHandle>,
): TweakApi["settings"] {
  if (!manifest.permissions?.includes("settings") || !host) return undefined;
  return {
    register(section) {
      return trackSettingsHandle(host.registerSection(manifest.id, section), handles);
    },
    registerPage(page) {
      return trackSettingsHandle(host.registerPage(manifest.id, manifest, page), handles);
    },
  };
}

function trackSettingsHandle(
  registered: SettingsHandle,
  handles: Set<SettingsHandle>,
): SettingsHandle {
  const handle: SettingsHandle = {
    unregister() {
      if (!handles.delete(handle)) return;
      registered.unregister();
    },
  };
  handles.add(handle);
  return handle;
}

function isRunnableRendererTweak(tweak: ListedTweakView): boolean {
  const scope = tweak.manifest.scope ?? "both";
  return tweak.enabled && tweak.entryExists && tweak.compatible && scope !== "main";
}

function unwrapDefault(value: unknown): unknown {
  if (value && typeof value === "object" && "default" in value) {
    return (value as { default: unknown }).default;
  }
  return value;
}

function isTweak(value: unknown): value is Tweak {
  return value !== null && typeof value === "object" &&
    typeof (value as { start?: unknown }).start === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
