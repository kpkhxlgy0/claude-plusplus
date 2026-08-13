import assert from "node:assert/strict";
import test from "node:test";
import {
  createMainTweakIpc,
  createRendererTweakIpc,
} from "../src/tweak-ipc.ts";

test("Main IPC broadcasts in the Tweak namespace and disposes handlers", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const windowMessages: unknown[][] = [];
  const bridge = {
    on(channel: string, listener: (...args: unknown[]) => void): void {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void): void {
      listeners.get(channel)?.delete(listener);
    },
    handle(channel: string, handler: (...args: unknown[]) => unknown): void {
      handlers.set(channel, handler);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    getWebContents(): Array<{ isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }> {
      return [{
        isDestroyed: () => false,
        send(channel, ...args): void {
          windowMessages.push([channel, ...args]);
        },
      }];
    },
  };
  const lease = createMainTweakIpc("com.example.one", bridge);
  const received: unknown[][] = [];
  lease.api.on("request-ready", (...args) => received.push(args));
  lease.api.handle?.("claim-next", (...args) => args[0]);

  lease.api.send("request-ready", { requestId: "r1" });
  listeners.get("claudepp:com.example.one:request-ready")?.forEach((listener) =>
    listener({ sender: "renderer" }, { requestId: "r2" }));

  assert.deepEqual(windowMessages, [[
    "claudepp:com.example.one:request-ready",
    { requestId: "r1" },
  ]]);
  assert.deepEqual(received, [[{ requestId: "r2" }]]);
  assert.equal(
    await handlers.get("claudepp:com.example.one:claim-next")?.({}, "r3"),
    "r3",
  );
  assert.throws(() => lease.api.handle?.("claim-next", () => undefined), /already registered/);
  await assert.rejects(() => lease.api.invoke("renderer-only"), /cannot invoke Renderer/i);

  await lease.dispose();
  await lease.dispose();
  assert.equal(handlers.has("claudepp:com.example.one:claim-next"), false);
  assert.equal(listeners.get("claudepp:com.example.one:request-ready")?.size, 0);
});

test("Renderer IPC uses the namespace, times out, and removes listeners", async () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sent: unknown[][] = [];
  const invoked: unknown[][] = [];
  const bridge = {
    on(channel: string, listener: (...args: unknown[]) => void): void {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void): void {
      listeners.get(channel)?.delete(listener);
    },
    send(channel: string, ...args: unknown[]): void {
      sent.push([channel, ...args]);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      invoked.push([channel, ...args]);
      if (channel.endsWith(":never-answers")) return await new Promise(() => {});
      return "claimed";
    },
  };
  const lease = createRendererTweakIpc("com.example.one", bridge, 10);
  const received: unknown[][] = [];
  const unsubscribe = lease.api.on("request-ready", (...args) => received.push(args));

  lease.api.send("request-ready", { requestId: "r1" });
  assert.equal(await lease.api.invoke("claim-next"), "claimed");
  listeners.get("claudepp:com.example.one:request-ready")?.forEach((listener) =>
    listener({}, { requestId: "r2" }));

  assert.deepEqual(sent, [["claudepp:com.example.one:request-ready", { requestId: "r1" }]]);
  assert.deepEqual(invoked[0], ["claudepp:com.example.one:claim-next"]);
  assert.deepEqual(received, [[{ requestId: "r2" }]]);
  await assert.rejects(() => lease.api.invoke("never-answers"), /timed out/);
  assert.throws(() => lease.api.handle?.("main-only", () => undefined), /cannot handle Main/i);

  unsubscribe();
  await lease.dispose();
  assert.equal(listeners.get("claudepp:com.example.one:request-ready")?.size, 0);
});

test("rejects invalid local IPC channel names", () => {
  const bridge = {
    on(): void {},
    removeListener(): void {},
    send(): void {},
    async invoke(): Promise<unknown> {
      return undefined;
    },
  };
  const lease = createRendererTweakIpc("com.example.one", bridge);

  for (const channel of ["", "bad/name", "bad:name", "bad\nname", `a${"b".repeat(64)}`]) {
    assert.throws(() => lease.api.send(channel), /Tweak IPC channel is invalid/);
  }
});

test("does not retain a handler reservation when Electron registration fails", () => {
  let fail = true;
  const bridge = {
    on(): void {},
    removeListener(): void {},
    handle(): void {
      if (fail) throw new Error("Electron rejected handler");
    },
    removeHandler(): void {},
    getWebContents: () => [],
  };
  const first = createMainTweakIpc("com.example.retry", bridge);
  assert.throws(() => first.api.handle?.("claim-next", () => undefined), /Electron rejected/);

  fail = false;
  const second = createMainTweakIpc("com.example.retry", bridge);
  assert.doesNotThrow(() => second.api.handle?.("claim-next", () => undefined));
});
