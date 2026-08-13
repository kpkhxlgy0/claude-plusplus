import assert from "node:assert/strict";
import test from "node:test";
import { createRendererLogger } from "../src/preload/renderer-logger.ts";

test("forwards Renderer preload lifecycle messages to main through IPC", () => {
  const invocations: unknown[][] = [];
  const log = createRendererLogger({
    async invoke(channel, ...args) {
      invocations.push([channel, ...args]);
      return true;
    },
  });

  log.info("preload evaluated");
  log.warn("fixture warning");
  log.error("fixture error");

  assert.deepEqual(invocations, [
    ["claudepp:renderer-log", "info", "preload evaluated"],
    ["claudepp:renderer-log", "warn", "fixture warning"],
    ["claudepp:renderer-log", "error", "fixture error"],
  ]);
});
