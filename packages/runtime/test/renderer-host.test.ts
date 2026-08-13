import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TweakApi, TweakManifest } from "@claude-plusplus/sdk";
import { discoverTweaks } from "../src/tweak-discovery.ts";
import {
  createRendererTweakRuntime,
  evaluateRendererTweak,
  startRendererTweaks,
} from "../src/preload/tweak-host.ts";
import type { ListedTweakView } from "../src/settings/types.ts";

test("evaluates and starts a Renderer Tweak with the same leased API object", async () => {
  const values = new Map<string, string>();
  const lifecycle = await startRendererTweaks({
    loadTweaks: async () => [{
      manifest: manifest(),
      source: [
        "const evaluatedApi = api;",
        "module.exports = {",
        "  start(startApi) {",
        "    if (startApi !== evaluatedApi) throw new Error('API object changed');",
        "    startApi.storage.set('started', true);",
        "  },",
        "};",
      ].join("\n"),
      filename: "same-api.js",
    }],
    log: apiFor(manifest()).log,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    ipc: {
      on() {},
      removeListener() {},
      send() {},
      invoke: async () => undefined,
    },
  });

  assert.equal(JSON.parse(values.get("claudepp:storage:com.example.renderer") ?? "{}").started, true);
  await lifecycle.stopAll();
});

test("isolates an evaluation failure and starts later Renderer Tweaks", async () => {
  const values = new Map<string, string>();
  const errors: unknown[][] = [];
  const lifecycle = await startRendererTweaks({
    loadTweaks: async () => [
      {
        manifest: { ...manifest(), id: "com.example.bad" },
        source: "throw new Error('evaluation failed');",
        filename: "bad.js",
      },
      {
        manifest: { ...manifest(), id: "com.example.good" },
        source: "module.exports = { start(api) { api.storage.set('started', true); } };",
        filename: "good.js",
      },
    ],
    log: { debug() {}, info() {}, warn() {}, error: (...args) => errors.push(args) },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    ipc: {
      on() {},
      removeListener() {},
      send() {},
      invoke: async () => undefined,
    },
  });

  assert.equal(JSON.parse(values.get("claudepp:storage:com.example.good") ?? "{}").started, true);
  assert.match(String(errors[0]?.[0]), /com\.example\.bad.*evaluation failed/);
  await lifecycle.stopAll();
});

test("rejects a Renderer Tweak with a former private permission during discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-private-permission-"));
  try {
    const dir = join(root, "com.example.private");
    mkdirSync(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      ...manifest(),
      id: "com.example.private",
      permissions: ["claude-composer"],
    }));
    writeFileSync(join(dir, "index.js"), "module.exports = { start() {} };\n");
    const issues: string[] = [];

    assert.deepEqual(discoverTweaks(root, "renderer", (issue) => issues.push(issue)), []);
    assert.match(issues[0] ?? "", /known Claude\+\+ permission string/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exposes registerPage only with settings permission and namespaces the registered page", async () => {
  const registrations: unknown[] = [];
  const values = new Map<string, string>();
  const lifecycle = await startRendererTweaks({
    loadTweaks: async () => [
      {
        manifest: { ...manifest(), id: "com.example.denied" },
        source: "module.exports = { start(api) { api.storage.set('hasSettings', !!api.settings); } };",
        filename: "denied.js",
      },
      {
        manifest: {
          ...manifest(),
          id: "com.example.allowed",
          permissions: ["settings"],
        },
        source: [
          "module.exports = {",
          "  start(api) {",
          "    api.settings.registerPage({",
          "      id: 'prompts',",
          "      title: 'Example Tweak',",
          "      render(root) { root.textContent = 'rendered'; },",
          "    });",
          "  },",
          "};",
        ].join("\n"),
        filename: "allowed.js",
      },
    ],
    log: apiFor(manifest()).log,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    ipc: {
      on() {},
      removeListener() {},
      send() {},
      invoke: async () => undefined,
    },
    settings: {
      registerSection() {
        return { unregister() {} };
      },
      registerPage(tweakId, value, page) {
        registrations.push([tweakId, value.id, `${tweakId}:${page.id}`, page.title]);
        return { unregister() {} };
      },
    },
  });

  assert.equal(JSON.parse(values.get("claudepp:storage:com.example.denied") ?? "{}").hasSettings, false);
  assert.deepEqual(registrations, [[
    "com.example.allowed",
    "com.example.allowed",
    "com.example.allowed:prompts",
    "Example Tweak",
  ]]);
  await lifecycle.stopAll();
});

test("automatically unregisters every settings page through the Tweak lease exactly once", async () => {
  let unregisterCount = 0;
  const lifecycle = await startRendererTweaks({
    loadTweaks: async () => [{
      manifest: { ...manifest(), permissions: ["settings"] },
      source: [
        "let explicit;",
        "module.exports = {",
        "  start(api) {",
        "    explicit = api.settings.registerPage({ id: 'explicit', title: 'Explicit', render() {} });",
        "    api.settings.registerPage({ id: 'forgotten', title: 'Forgotten', render() {} });",
        "    explicit.unregister();",
        "  },",
        "};",
      ].join("\n"),
      filename: "cleanup.js",
    }],
    log: apiFor(manifest()).log,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    ipc: {
      on() {},
      removeListener() {},
      send() {},
      invoke: async () => undefined,
    },
    settings: {
      registerSection() {
        return { unregister() {} };
      },
      registerPage() {
        let registered = true;
        return {
          unregister() {
            if (!registered) return;
            registered = false;
            unregisterCount += 1;
          },
        };
      },
    },
  });

  assert.equal(unregisterCount, 1);
  await lifecycle.stopAll();
  assert.equal(unregisterCount, 2);
});

test("registers and disposes both Settings sections and pages in reverse order", async () => {
  const registered: string[] = [];
  const removed: string[] = [];
  const lifecycle = await startRendererTweaks({
    loadTweaks: async () => [{
      manifest: { ...manifest(), permissions: ["settings"] },
      source: [
        "module.exports = {",
        "  start(api) {",
        "    api.settings.register({ id: 'inline', title: 'Inline', render() {} });",
        "    api.settings.registerPage({ id: 'prompts', title: 'Prompts', render() {} });",
        "  },",
        "};",
      ].join("\n"),
      filename: "settings.js",
    }],
    log: apiFor(manifest()).log,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    ipc: {
      on() {},
      removeListener() {},
      send() {},
      invoke: async () => undefined,
    },
    settings: {
      registerSection(_tweakId, section) {
        registered.push(section.id);
        return { unregister: () => { removed.push(section.id); } };
      },
      registerPage(_tweakId, _manifest, page) {
        registered.push(page.id);
        return { unregister: () => { removed.push(page.id); } };
      },
    },
  });

  assert.deepEqual(registered, ["inline", "prompts"]);
  await lifecycle.stopAll();
  assert.deepEqual(removed, ["prompts", "inline"]);
});

test("continues Settings cleanup after one unregister handle fails", async () => {
  const removed: string[] = [];
  const lifecycle = await startRendererTweaks({
    loadTweaks: async () => [{
      manifest: { ...manifest(), permissions: ["settings"] },
      source: [
        "module.exports = {",
        "  start(api) {",
        "    api.settings.register({ id: 'inline', title: 'Inline', render() {} });",
        "    api.settings.registerPage({ id: 'broken', title: 'Broken', render() {} });",
        "  },",
        "};",
      ].join("\n"),
      filename: "settings-cleanup.js",
    }],
    log: apiFor(manifest()).log,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    ipc: { on() {}, removeListener() {}, send() {}, invoke: async () => undefined },
    settings: {
      registerSection(_tweakId, section) {
        return { unregister: () => { removed.push(section.id); } };
      },
      registerPage() {
        return { unregister: () => { throw new Error("fixture unregister failure"); } };
      },
    },
  });

  await lifecycle.stopAll();

  assert.deepEqual(removed, ["inline"]);
});

test("evaluates the generic Core Probe Settings lifecycle", async () => {
  const fixture = resolve("packages", "runtime", "test", "fixtures", "com.claudeplusplus.probe");
  const value = JSON.parse(readFileSync(resolve(fixture, "manifest.json"), "utf8")) as TweakManifest;
  const source = readFileSync(resolve(fixture, "index.js"), "utf8");
  let page: Parameters<NonNullable<TweakApi["settings"]>["registerPage"]>[0] | undefined;
  let unregisterCount = 0;
  const api: TweakApi = {
    ...apiFor(value),
    settings: {
      register() {
        throw new Error("section registration is not expected");
      },
      registerPage(candidate) {
        page = candidate;
        return {
          unregister() {
            unregisterCount += 1;
          },
        };
      },
    },
  };
  const tweak = evaluateRendererTweak(source, "core-probe/index.js", api);

  await tweak.start(api);
  assert.equal(page?.id, "probe");
  assert.equal(page?.title, "Claude++ Probe");
  const root = { textContent: "" };
  page?.render(root as HTMLElement);
  assert.equal(root.textContent, "Claude++ settings page is active.");

  await tweak.stop?.();
  assert.equal(unregisterCount, 1);
});

test("does not expose Node require to Renderer Tweak code", () => {
  assert.throws(
    () => evaluateRendererTweak("module.exports = require('node:fs');", "bad.js", apiFor(manifest())),
    /require.*not.*function|require is not defined/i,
  );
});

test("publishes the full catalog before loading only runnable Renderer Tweaks", async () => {
  const published: string[][] = [];
  const reads: string[] = [];
  const runtime = createRendererTweakRuntime({
    loadCatalog: async () => ({
      tweaksPath: "D:\\Tweaks",
      tweaks: [
        listed("com.example.disabled", { enabled: false }),
        listed("com.example.missing", { entryExists: false }),
        listed("com.example.enabled"),
      ],
    }),
    readTweakSource: async (entry) => {
      reads.push(entry);
      return "module.exports = { start() {} };";
    },
    publishCatalog: (tweaks) => { published.push(tweaks.map((item) => item.manifest.id)); },
    subscribeReload: () => () => {},
    clearSettings() {},
    log: apiFor(manifest()).log,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    ipc: { on() {}, removeListener() {}, send() {}, invoke: async () => undefined },
  });

  await runtime.start();

  assert.deepEqual(published, [[
    "com.example.disabled",
    "com.example.missing",
    "com.example.enabled",
  ]]);
  assert.deepEqual(reads, ["D:\\Tweaks\\com.example.enabled\\index.js"]);
  await runtime.dispose();
});

test("coalesces reload broadcasts while Renderer reconstruction is in flight", async () => {
  let reload: (() => void) | undefined;
  let releaseCatalog: (() => void) | undefined;
  let catalogLoads = 0;
  const runtime = createRendererTweakRuntime({
    loadCatalog: async () => {
      catalogLoads += 1;
      if (catalogLoads === 1) {
        await new Promise<void>((resolvePromise) => { releaseCatalog = resolvePromise; });
      }
      return { tweaksPath: "D:\\Tweaks", tweaks: [] };
    },
    readTweakSource: async () => "",
    publishCatalog() {},
    subscribeReload(listener) {
      reload = listener;
      return () => {};
    },
    clearSettings() {},
    log: apiFor(manifest()).log,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    ipc: { on() {}, removeListener() {}, send() {}, invoke: async () => undefined },
  });

  const started = runtime.start();
  reload?.();
  reload?.();
  releaseCatalog?.();
  await started;

  assert.equal(catalogLoads, 1);
  reload?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(catalogLoads, 2);
  await runtime.dispose();
});

function manifest(): TweakManifest {
  return {
    id: "com.example.renderer",
    name: "Renderer",
    version: "0.2.0",
    githubRepo: "example/renderer",
    scope: "renderer",
  };
}

function listed(
  id: string,
  overrides: { enabled?: boolean; entryExists?: boolean } = {},
): ListedTweakView {
  return {
    manifest: { ...manifest(), id },
    dir: `D:\\Tweaks\\${id}`,
    entry: `D:\\Tweaks\\${id}\\index.js`,
    entryExists: overrides.entryExists ?? true,
    compatible: true,
    enabled: overrides.enabled ?? true,
    update: null,
  };
}

function apiFor(value: TweakManifest): TweakApi {
  return {
    manifest: value,
    storage: {
      get: <T>(_key: string, fallback?: T) => fallback as T,
      set() {},
      delete() {},
      all: () => ({}),
    },
    process: "renderer",
    log: { debug() {}, info() {}, warn() {}, error() {} },
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
  };
}
