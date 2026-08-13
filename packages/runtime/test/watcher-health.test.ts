import assert from "node:assert/strict";
import test from "node:test";
import { buildWatcherHealth } from "../src/watcher-health.ts";

test("health disables automatic refresh until Watcher exists", () => {
  const health = buildWatcherHealth({ watcher: "none", autoUpdate: true, tasks: [] });
  assert.equal(health.installed, false);
  assert.equal(health.autoUpdateAvailable, false);
  assert.equal(health.status, "warn");
  assert.match(health.summary, /not installed/i);
});

test("health is ready only when both logon and five-minute tasks plus script exist", () => {
  const health = buildWatcherHealth({
    watcher: "scheduled-task",
    autoUpdate: true,
    scriptExists: true,
    tasks: ["claude-plusplus-watcher", "claude-plusplus-watcher-interval"],
  });
  assert.equal(health.installed, true);
  assert.equal(health.autoUpdateAvailable, true);
  assert.equal(health.status, "ok");
  assert.match(health.summary, /logon.*five minutes/i);
});
