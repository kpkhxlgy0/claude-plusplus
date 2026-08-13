import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

test("built Renderer preload boots when the sandbox only exposes Electron", async () => {
  const source = readFileSync(resolve("packages", "runtime", "dist", "preload", "index.js"), "utf8");
  const invocations = [];
  const ipcRenderer = {
    async invoke(channel, ...args) {
      invocations.push([channel, ...args]);
      if (channel === "claudepp:list-tweaks") return [];
      if (channel === "claudepp:user-paths") return { tweaksDir: "D:\\Tweaks" };
      if (channel === "claudepp:renderer-log") return true;
      throw new Error(`unexpected IPC channel: ${channel}`);
    },
    on() {},
    removeListener() {},
  };
  let settingsObserverCount = 0;
  class MutationObserver {
    constructor() {}
    observe() {
      settingsObserverCount += 1;
    }
    disconnect() {}
  }
  const document = {
    readyState: "complete",
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
  };
  const window = {
    addEventListener() {},
  };
  const context = vm.createContext({
    console,
    document,
    exports: {},
    location: { href: "file:///claude/index.html" },
    module: { exports: {} },
    MutationObserver,
    process: { versions: { electron: "41.3.0" } },
    queueMicrotask,
    require(specifier) {
      if (specifier === "electron") return { ipcRenderer, webFrame: { executeJavaScript() {} } };
      throw new Error(`module not found: ${specifier}`);
    },
    setTimeout,
    URL,
    window,
  });

  new vm.Script(source, { filename: "claude-plusplus-preload.js" }).runInContext(context);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.ok(invocations.some(([channel]) => channel === "claudepp:list-tweaks"));
  assert.ok(invocations.some(([channel]) => channel === "claudepp:user-paths"));
  assert.equal(invocations.some(([channel]) => channel === "claudepp:renderer-tweaks"), false);
  assert.ok(invocations.some(([, level, message]) =>
    level === "info" && String(message).includes("Renderer preload evaluated")));
  assert.equal(settingsObserverCount, 1);
});
