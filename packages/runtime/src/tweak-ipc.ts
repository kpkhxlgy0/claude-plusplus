import type { TweakIpc } from "@claude-plusplus/sdk";

export interface TweakIpcLease {
  api: TweakIpc;
  dispose(): Promise<void>;
}

export interface MainTweakIpcBridge {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  getWebContents(): Array<{
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  }>;
}

export interface RendererTweakIpcBridge {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

const registeredHandlers = new WeakMap<MainTweakIpcBridge, Set<string>>();

export function createMainTweakIpc(id: string, bridge: MainTweakIpcBridge): TweakIpcLease {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const handlers = new Set<string>();
  const bridgeHandlers = registeredHandlers.get(bridge) ?? new Set<string>();
  registeredHandlers.set(bridge, bridgeHandlers);
  let disposed = false;

  const api: TweakIpc = {
    on(channel, handler) {
      const namespaced = tweakChannel(id, channel);
      const listener = (_event: unknown, ...args: unknown[]) => handler(...args);
      bridge.on(namespaced, listener);
      const channelListeners = listeners.get(namespaced) ?? new Set();
      channelListeners.add(listener);
      listeners.set(namespaced, channelListeners);
      return () => {
        if (!channelListeners.delete(listener)) return;
        bridge.removeListener(namespaced, listener);
      };
    },
    send(channel, ...args) {
      const namespaced = tweakChannel(id, channel);
      for (const webContents of bridge.getWebContents()) {
        if (!webContents.isDestroyed()) webContents.send(namespaced, ...args);
      }
    },
    async invoke(): Promise<never> {
      throw new Error("Main Tweak IPC cannot invoke Renderer handlers");
    },
    handle(channel, handler) {
      const namespaced = tweakChannel(id, channel);
      if (bridgeHandlers.has(namespaced)) {
        throw new Error(`Tweak IPC handler is already registered: ${channel}`);
      }
      bridgeHandlers.add(namespaced);
      handlers.add(namespaced);
      try {
        bridge.handle(namespaced, (_event: unknown, ...args: unknown[]) => handler(...args));
      } catch (error) {
        handlers.delete(namespaced);
        bridgeHandlers.delete(namespaced);
        throw error;
      }
    },
  };

  return {
    api,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const [channel, channelListeners] of listeners) {
        for (const listener of channelListeners) bridge.removeListener(channel, listener);
      }
      for (const channel of handlers) {
        bridge.removeHandler(channel);
        bridgeHandlers.delete(channel);
      }
      listeners.clear();
      handlers.clear();
    },
  };
}

export function createRendererTweakIpc(
  id: string,
  bridge: RendererTweakIpcBridge,
  timeoutMs = 5_000,
): TweakIpcLease {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let disposed = false;
  const api: TweakIpc = {
    on(channel, handler) {
      const namespaced = tweakChannel(id, channel);
      const listener = (_event: unknown, ...args: unknown[]) => handler(...args);
      bridge.on(namespaced, listener);
      const channelListeners = listeners.get(namespaced) ?? new Set();
      channelListeners.add(listener);
      listeners.set(namespaced, channelListeners);
      return () => {
        if (!channelListeners.delete(listener)) return;
        bridge.removeListener(namespaced, listener);
      };
    },
    send(channel, ...args) {
      bridge.send(tweakChannel(id, channel), ...args);
    },
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      const namespaced = tweakChannel(id, channel);
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          bridge.invoke(namespaced, ...args) as Promise<T>,
          new Promise<T>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Tweak IPC invoke timed out: ${channel}`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    handle() {
      throw new Error("Renderer Tweak IPC cannot handle Main invocations");
    },
  };

  return {
    api,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const [channel, channelListeners] of listeners) {
        for (const listener of channelListeners) bridge.removeListener(channel, listener);
      }
      listeners.clear();
    },
  };
}

export function tweakChannel(id: string, channel: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(channel)) {
    throw new Error("Tweak IPC channel is invalid");
  }
  return `claudepp:${id}:${channel}`;
}
