import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import {
  type ClaudePlusPlusUpdateCheck,
  type RuntimeConfig,
  type TweakUpdateCheck,
} from "../src/config.ts";
import { installManagementIpc } from "../src/management-ipc.ts";
import type { ListedTweak } from "../src/tweak-catalog.ts";
import {
  createTweakUpdateChecker,
  type TweakUpdateChecker,
} from "../src/tweak-update.ts";

test("management IPC persists a valid Tweak toggle before reload and disposes every handler", async () => {
  const fixture = managementFixture([tweak("com.example.toggle")]);
  let persistedBeforeReload = false;
  fixture.install({
    async ensure({ manifest }) {
      return updateFor(manifest.id);
    },
  }, (reason, configFile) => {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as RuntimeConfig;
    persistedBeforeReload = reason === "enabled-toggle" &&
      config.tweaks["com.example.toggle"]?.enabled === false;
  });
  try {
    await fixture.invoke("claudepp:set-tweak-enabled", "com.example.toggle", false);
    assert.equal(persistedBeforeReload, true);
  } finally {
    fixture.dispose();
  }
});

test("list-tweaks starts every entry-present check before awaiting and returns fresh results", async () => {
  const fixture = managementFixture([
    tweak("com.example.one"),
    tweak("com.example.two", { enabled: false }),
    tweak("com.example.three"),
    tweak("com.example.missing", { entryExists: false }),
    tweak("com.example.future", { minRuntime: "99.0.0" }),
  ]);
  const pending = new Map<string, Deferred<TweakUpdateCheck>>();
  const started: string[] = [];
  fixture.install({
    ensure({ manifest }) {
      started.push(manifest.id);
      const gate = deferred<TweakUpdateCheck>();
      pending.set(manifest.id, gate);
      return gate.promise;
    },
  });
  try {
    const response = fixture.invoke("claudepp:list-tweaks");
    assert.deepEqual(started.sort(), [
      "com.example.future",
      "com.example.one",
      "com.example.three",
      "com.example.two",
    ]);
    assert.equal(await isSettled(response), false);

    for (const [id, gate] of pending) gate.resolve(updateFor(id));
    const listed = await response as ListedTweak[];
    assert.equal(find(listed, "com.example.one").update?.latestVersion, "0.3.1");
    assert.equal(find(listed, "com.example.two").update?.latestVersion, "0.3.1");
    assert.equal(find(listed, "com.example.missing").update, null);
    assert.equal(find(listed, "com.example.future").update?.latestVersion, "0.3.1");
  } finally {
    fixture.dispose();
  }
});

test("concurrent list-tweaks calls share one same-identity request", async () => {
  const fixture = managementFixture([tweak("com.example.shared")]);
  const requestGate = deferred<Response>();
  let requests = 0;
  fixture.install(createTweakUpdateChecker({
    request: async () => {
      requests += 1;
      return await requestGate.promise;
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  }));
  try {
    const first = fixture.invoke("claudepp:list-tweaks");
    const second = fixture.invoke("claudepp:list-tweaks");
    assert.equal(requests, 1);
    assert.equal(await isSettled(first), false);
    assert.equal(await isSettled(second), false);

    requestGate.resolve(latestResponse());
    const [firstList, secondList] = await Promise.all([first, second]) as ListedTweak[][];
    assert.equal(find(firstList, "com.example.shared").update?.latestVersion, "0.3.1");
    assert.equal(find(secondList, "com.example.shared").update?.latestVersion, "0.3.1");
    assert.equal(requests, 1);
  } finally {
    fixture.dispose();
  }
});

test("list-tweaks attaches the current result when advisory persistence is refused", async () => {
  const fixture = managementFixture([tweak("com.example.refused")]);
  fixture.install(createTweakUpdateChecker({
    request: async () => latestResponse(),
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    persist: () => ({ status: "refused-invalid" }),
  }));
  try {
    const listed = await fixture.invoke("claudepp:list-tweaks") as ListedTweak[];
    assert.equal(find(listed, "com.example.refused").update?.latestVersion, "0.3.1");
  } finally {
    fixture.dispose();
  }
});

test("list-tweaks checks a runtime-incompatible entry-present Tweak", async () => {
  const fixture = managementFixture([
    tweak("com.example.future", { minRuntime: "99.0.0" }),
  ]);
  const started: string[] = [];
  fixture.install({
    async ensure({ manifest }) {
      started.push(manifest.id);
      return updateFor(manifest.id);
    },
  });
  try {
    const listed = await fixture.invoke("claudepp:list-tweaks") as ListedTweak[];
    const future = find(listed, "com.example.future");
    assert.equal(future.compatible, false);
    assert.deepEqual(started, ["com.example.future"]);
    assert.equal(future.update?.latestVersion, "0.3.1");
  } finally {
    fixture.dispose();
  }
});

test("a missing-entry Tweak returns only its matching seeded cache without starting a request", async () => {
  const cached = updateFor("com.example.missing");
  const fixture = managementFixture([
    tweak("com.example.missing", { entryExists: false, cachedUpdate: cached }),
  ]);
  let requests = 0;
  fixture.install({
    async ensure({ manifest }) {
      requests += 1;
      return updateFor(manifest.id);
    },
  });
  try {
    const listed = await fixture.invoke("claudepp:list-tweaks") as ListedTweak[];
    assert.equal(requests, 0);
    assert.deepEqual(find(listed, "com.example.missing").update, cached);
  } finally {
    fixture.dispose();
  }
});

test("a rejected checker request remains advisory and list-tweaks resolves", async () => {
  const fixture = managementFixture([tweak("com.example.rejected")]);
  fixture.install(createTweakUpdateChecker({
    request: async () => {
      throw new Error("fixture network denied");
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  }));
  try {
    const listed = await fixture.invoke("claudepp:list-tweaks") as ListedTweak[];
    const update = find(listed, "com.example.rejected").update;
    assert.equal(update?.updateAvailable, false);
    assert.equal(update?.error, "fixture network denied");
  } finally {
    fixture.dispose();
  }
});

test("a refused product update cache is logged without rejecting the handler", async () => {
  const warnings: string[] = [];
  const fixture = managementFixture([], {
    rawConfig: "{broken",
    onWarn: (message) => warnings.push(message),
  });
  fixture.install({
    async ensure() {
      throw new Error("empty catalog must not perform a Tweak release check");
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    tag_name: "v0.3.1",
    html_url: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
    body: "Fixture release notes",
    draft: false,
    prerelease: false,
  }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const update = await fixture.invoke("claudepp:check-claudepp-update", true) as ClaudePlusPlusUpdateCheck;
    assert.equal(update.latestVersion, "0.3.1");
    assert.deepEqual(warnings, ["Claude++ update cache refused-invalid"]);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.dispose();
  }
});

interface TweakSpec {
  manifest: TweakManifest;
  enabled: boolean;
  entryExists: boolean;
  cachedUpdate?: TweakUpdateCheck;
}

function tweak(
  id: string,
  options: {
    enabled?: boolean;
    entryExists?: boolean;
    minRuntime?: string;
    cachedUpdate?: TweakUpdateCheck;
  } = {},
): TweakSpec {
  return {
    manifest: {
      id,
      name: id,
      version: "0.2.0",
      githubRepo: repoFor(id),
      scope: "renderer",
      ...(options.minRuntime ? { minRuntime: options.minRuntime } : {}),
    },
    enabled: options.enabled ?? true,
    entryExists: options.entryExists ?? true,
    ...(options.cachedUpdate ? { cachedUpdate: options.cachedUpdate } : {}),
  };
}

function managementFixture(
  specs: TweakSpec[],
  options: { rawConfig?: string; onWarn?: (message: string) => void } = {},
): {
  install(
    checker: TweakUpdateChecker,
    onReload?: (reason: string, configFile: string) => void,
  ): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  dispose(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "claudepp-management-ipc-"));
  const tweaksRoot = join(root, "tweaks");
  const configFile = join(root, "config.json");
  mkdirSync(tweaksRoot, { recursive: true });
  for (const spec of specs) {
    const dir = join(tweaksRoot, spec.manifest.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(spec.manifest));
    if (spec.entryExists) writeFileSync(join(dir, "index.js"), "module.exports = { start() {} };\n");
  }
  const config: RuntimeConfig = {
    claudePlusPlus: {
      safeMode: false,
      autoUpdate: false,
      updateChannel: "stable",
      updateRepo: "kpkhxlgy0/claude-plusplus",
      updateRef: "",
    },
    tweaks: Object.fromEntries(specs.map((spec) => [spec.manifest.id, { enabled: spec.enabled }])),
    tweakUpdateChecks: Object.fromEntries(specs
      .filter((spec) => spec.cachedUpdate)
      .map((spec) => [spec.manifest.id, spec.cachedUpdate as TweakUpdateCheck])),
  };
  writeFileSync(configFile, options.rawConfig ?? `${JSON.stringify(config, null, 2)}\n`);

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  let uninstall: (() => void) | undefined;
  let disposed = false;
  return {
    install(checker, onReload = () => {}) {
      uninstall = installManagementIpc({
        electron: {
          ipcMain: {
            handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
              handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => { removed.push(channel); },
          },
          shell: {},
          clipboard: {},
        } as unknown as typeof import("electron"),
        userRoot: root,
        tweaksRoot,
        configFile,
        sourceRoot: join(root, "source"),
        log: { debug() {}, info() {}, warn: options.onWarn ?? (() => {}), error() {} },
        tweakUpdateChecker: checker,
        async reloadTweaks(reason) {
          onReload(reason, configFile);
        },
      });
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing management IPC handler: ${channel}`);
      return Promise.resolve(handler({}, ...args));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      uninstall?.();
      if (uninstall) assert.deepEqual(removed.sort(), [...handlers.keys()].sort());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function updateFor(id: string): TweakUpdateCheck {
  const repo = repoFor(id);
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    repo,
    currentVersion: "0.2.0",
    latestVersion: "0.3.1",
    latestTag: "v0.3.1",
    releaseUrl: `https://github.com/${repo}/releases/tag/v0.3.1`,
    updateAvailable: true,
  };
}

function repoFor(id: string): string {
  return `example/${id.replace(/^com\.example\./, "")}`;
}

function latestResponse(): Response {
  return new Response(JSON.stringify({
    tag_name: "v0.3.1",
    html_url: "https://github.com/example/tweak/releases/tag/v0.3.1",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function find(list: ListedTweak[], id: string): ListedTweak {
  const item = list.find((candidate) => candidate.manifest.id === id);
  assert.ok(item, `missing listed Tweak: ${id}`);
  return item;
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
