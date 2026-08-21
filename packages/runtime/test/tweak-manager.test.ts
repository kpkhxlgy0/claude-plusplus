import assert from "node:assert/strict";
import test from "node:test";
import { TweakManager, type TweakWatcher } from "../src/tweak-manager.ts";

test("reload stops main Tweaks, clears modules, rediscovers, starts, then broadcasts", async () => {
  const calls: string[] = [];
  const activeRegistrations = new Set(["old"]);
  const observedAtReplacementStart: string[][] = [];
  const manager = new TweakManager({
    async stopMainTweaks() {
      calls.push("stop");
      activeRegistrations.clear();
    },
    clearMainModuleCache() { calls.push("clear-cache"); },
    discoverMainTweaks() { calls.push("discover"); return []; },
    async startMainTweaks() {
      observedAtReplacementStart.push([...activeRegistrations]);
      activeRegistrations.add("replacement");
      calls.push("start");
    },
    broadcastRendererReload() { calls.push("broadcast"); },
    log() {},
  });

  await manager.reload("enabled-toggle");

  assert.deepEqual(calls, ["stop", "clear-cache", "discover", "start", "broadcast"]);
  assert.deepEqual(observedAtReplacementStart, [[]]);
  assert.deepEqual([...activeRegistrations], ["replacement"]);
});

test("filesystem changes debounce to one reload and ignore node_modules", async () => {
  const scheduled: Array<() => void> = [];
  const delays: number[] = [];
  let allListener: ((event: string, path: string) => void) | undefined;
  let ignored: ((path: string) => boolean) | undefined;
  let reloads = 0;
  const watcher: TweakWatcher = {
    on(event, listener) {
      if (event === "all") allListener = listener as (event: string, path: string) => void;
      return this;
    },
    async close() {},
  };
  const manager = new TweakManager({
    async stopMainTweaks() { reloads += 1; },
    clearMainModuleCache() {},
    discoverMainTweaks() { return []; },
    async startMainTweaks() {},
    broadcastRendererReload() {},
    log() {},
  }, {
    watchFactory(_root, options) {
      ignored = options.ignored;
      return watcher;
    },
    setTimer(callback, delay) {
      scheduled.push(callback);
      delays.push(delay);
      return scheduled.length;
    },
    clearTimer() {},
  });
  const dispose = manager.watch("D:\\tweaks");

  allListener?.("change", "D:\\tweaks\\com.example.one\\index.js");
  allListener?.("change", "D:\\tweaks\\.claudepp-safe-mode-reload");
  if (!ignored?.("D:\\tweaks\\com.example.one\\node_modules\\pkg\\index.js")) {
    allListener?.("change", "D:\\tweaks\\com.example.one\\node_modules\\pkg\\index.js");
  }
  assert.deepEqual(delays, [250, 250]);
  assert.equal(reloads, 0);

  await scheduled.at(-1)?.();

  assert.equal(reloads, 1);
  await dispose();
});

test("watcher disposal cancels pending reload and closes the watcher", async () => {
  let listener: ((event: string, path: string) => void) | undefined;
  let cleared = 0;
  let closed = 0;
  const manager = new TweakManager({
    async stopMainTweaks() {},
    clearMainModuleCache() {},
    discoverMainTweaks() { return []; },
    async startMainTweaks() {},
    broadcastRendererReload() {},
    log() {},
  }, {
    watchFactory() {
      return {
        on(event, next) {
          if (event === "all") listener = next as (event: string, path: string) => void;
          return this;
        },
        async close() { closed += 1; },
      };
    },
    setTimer() { return 7; },
    clearTimer() { cleared += 1; },
  });
  const dispose = manager.watch("D:\\tweaks");
  listener?.("change", "D:\\tweaks\\index.js");

  await dispose();

  assert.equal(cleared, 1);
  assert.equal(closed, 1);
});
