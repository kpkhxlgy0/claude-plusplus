import assert from "node:assert/strict";
import test from "node:test";
import type { Tweak, TweakApi, TweakManifest } from "@claude-plusplus/sdk";
import {
  TweakLifecycle,
  type RunnableTweak,
  type TweakApiLease,
} from "../src/tweak-lifecycle.ts";

test("starts each Tweak once and stops and disposes it at most once", async () => {
  const calls: string[] = [];
  const lifecycle = new TweakLifecycle(() => {});
  const tweak = runnable("com.example.once", {
    start() { calls.push("start"); },
    stop() { calls.push("stop"); },
  });

  await lifecycle.startAll([tweak], (value) => leaseFor(value, calls));
  await lifecycle.startAll([tweak], (value) => leaseFor(value, calls));
  await lifecycle.stopAll();
  await lifecycle.stopAll();

  assert.deepEqual(calls, ["start", "stop", "dispose"]);
});

test("reload revokes the old registration before the replacement starts", async () => {
  const calls: string[] = [];
  const lifecycle = new TweakLifecycle(() => {});
  const activeRegistrations = new Set<number>();
  const observedAtStart: number[][] = [];
  let generation = 0;
  const tweak = runnable("com.example.reload", {
    start() {
      observedAtStart.push([...activeRegistrations]);
      activeRegistrations.add(generation);
      calls.push(`start-${generation}`);
    },
    stop() { calls.push(`stop-${generation}`); },
  });
  const factory = (value: TweakManifest): TweakApiLease => {
    generation += 1;
    const leaseGeneration = generation;
    const lease = leaseFor(value, calls, `dispose-${leaseGeneration}`);
    return {
      ...lease,
      dispose() {
        activeRegistrations.delete(leaseGeneration);
        return lease.dispose();
      },
    };
  };

  await lifecycle.startAll([tweak], factory);
  await lifecycle.reloadAll([tweak], factory);

  assert.deepEqual(calls, ["start-1", "stop-1", "dispose-1", "start-2"]);
  assert.deepEqual(observedAtStart, [[], []]);
  assert.deepEqual([...activeRegistrations], [2]);
});

test("stops Tweaks and disposes their leases in reverse order", async () => {
  const calls: string[] = [];
  const lifecycle = new TweakLifecycle(() => {});
  const tweaks = ["one", "two"].map((id) => runnable(`com.example.${id}`, {
    start() { calls.push(`start-${id}`); },
    stop() { calls.push(`stop-${id}`); },
  }));

  await lifecycle.startAll(tweaks, (value) => leaseFor(value, calls, `dispose-${value.id}`));
  await lifecycle.stopAll();

  assert.deepEqual(calls, [
    "start-one",
    "start-two",
    "stop-two",
    "dispose-com.example.two",
    "stop-one",
    "dispose-com.example.one",
  ]);
});

test("quit cleanup starts every stop and lease disposal without awaiting pending hooks", async () => {
  const calls: string[] = [];
  const lifecycle = new TweakLifecycle(() => {});
  const neverSettles = new Promise<void>(() => {});
  const tweaks = [
    runnable("com.example.one", {
      start() { calls.push("start-one"); },
      stop() { calls.push("stop-one"); },
    }),
    runnable("com.example.two", {
      start() { calls.push("start-two"); },
      stop() {
        calls.push("stop-two");
        return neverSettles;
      },
    }),
  ];

  await lifecycle.startAll(tweaks, (value) => ({
    ...leaseFor(value, calls, `dispose-${value.id}`),
    disposeForQuit() {
      calls.push(`dispose-for-quit-${value.id}`);
    },
  }));
  lifecycle.stopAllForQuit();

  assert.deepEqual(calls, [
    "start-one",
    "start-two",
    "stop-two",
    "dispose-for-quit-com.example.two",
    "stop-one",
    "dispose-for-quit-com.example.one",
  ]);
  await lifecycle.stopAll();
  assert.equal(calls.length, 6);
});

test("scope both receives independent API objects in Main and Renderer", async () => {
  const seen: TweakApi[] = [];
  const tweak = runnable("com.example.both", {
    start(api) { seen.push(api); },
  }, "both");
  const main = new TweakLifecycle(() => {});
  const renderer = new TweakLifecycle(() => {});

  await main.startAll([tweak], (value) => leaseFor(value, [], undefined, "main"));
  await renderer.startAll([tweak], (value) => leaseFor(value, [], undefined, "renderer"));

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(seen[0]?.process, "main");
  assert.equal(seen[1]?.process, "renderer");
});

test("disposes a failed start and continues with later Tweaks", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const lifecycle = new TweakLifecycle((message) => errors.push(message));

  await lifecycle.startAll([
    runnable("com.example.bad", { start() { throw new Error("boom"); } }),
    runnable("com.example.good", { start() { calls.push("good"); } }),
  ], (value) => leaseFor(value, calls, `dispose-${value.id}`));

  assert.deepEqual(calls, ["dispose-com.example.bad", "good"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /com\.example\.bad.*boom/);
});

test("isolates API lease factory failures from later Tweaks", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const lifecycle = new TweakLifecycle((message) => errors.push(message));

  await lifecycle.startAll([
    runnable("com.example.bad-api", { start() { calls.push("unexpected"); } }),
    runnable("com.example.good-api", { start() { calls.push("good"); } }),
  ], (value) => {
    if (value.id === "com.example.bad-api") throw new Error("lease failed");
    return leaseFor(value, calls);
  });

  assert.deepEqual(calls, ["good"]);
  assert.match(errors.join("\n"), /com\.example\.bad-api.*lease failed/);
});

function runnable(id: string, tweak: Tweak, scope: TweakManifest["scope"] = "renderer"): RunnableTweak {
  return { manifest: manifest(id, scope), tweak };
}

function manifest(id: string, scope: TweakManifest["scope"]): TweakManifest {
  return { id, name: id, version: "0.2.0", githubRepo: "example/tweak", scope };
}

function leaseFor(
  manifestValue: TweakManifest,
  calls: string[],
  disposeLabel = "dispose",
  process: TweakApi["process"] = "renderer",
): TweakApiLease {
  return {
    api: {
      manifest: manifestValue,
      storage: {
        get: <T>(_key: string, fallback?: T) => fallback as T,
        set() {},
        delete() {},
        all: () => ({}),
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      process,
      ipc: {
        on: () => () => {},
        send() {},
        invoke: async <T>() => undefined as T,
      },
      fs: {
        dataDir: "D:\\data",
        read: async () => "",
        write: async () => {},
        exists: async () => false,
      },
    },
    dispose() {
      calls.push(disposeLabel);
    },
  };
}
