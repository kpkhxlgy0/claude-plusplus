import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type {
  TweakStoreEntryView,
  TweakStoreRegistryView,
} from "../src/tweak-store.ts";
import {
  clearStoreCache,
  renderStorePage,
  warmTweakStore,
  type StorePageContext,
} from "../src/settings/store-page.ts";
import { settingsFixture } from "./fixtures/settings-dom.ts";

beforeEach(() => clearStoreCache());
afterEach(() => clearStoreCache());

test("renders the approved empty Store state and Publish Tweak", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  await renderStorePage(context(root), registry([]));

  assert.match(root.textContent ?? "", /No tweaks yet.*Publish Tweak/);
});

test("disables incompatible Store entries and installs a reviewed compatible entry", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const calls: string[] = [];
  await renderStorePage(context(root, calls), registry([
    entry("com.example.ok", "Compatible Tweak"),
    entry("com.example.locked", "Locked Tweak", false),
  ]));

  fixture.click(root.querySelector('[data-claudepp-store-install="com.example.ok"]'));
  await Promise.resolve();

  assert.deepEqual(calls, ["com.example.ok"]);
  assert.match(root.textContent ?? "", /Verified as safe.*Requires newer Claude\+\+/);
  assert.equal(root.querySelector('[data-claudepp-store-install="com.example.locked"]'), null);
});

test("restores the Store install action and reports a failed install inline", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const pageContext = context(root);
  pageContext.invoke = async (channel: string) => {
    if (channel === "claudepp:install-store-tweak") throw new Error("archive rejected");
    return undefined;
  };
  await renderStorePage(pageContext, registry([entry("com.example.fail", "Failed Tweak")]));

  const install = root.querySelector('[data-claudepp-store-install="com.example.fail"]');
  fixture.click(install);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(install?.disabled, false);
  assert.match(root.textContent ?? "", /Install failed.*archive rejected/);
});

test("warm and normal page render share one in-flight Store request", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const gate = deferred<TweakStoreRegistryView>();
  let requests = 0;
  const page = context(root, [], async (channel: string) => {
    assert.equal(channel, "claudepp:get-tweak-store");
    requests += 1;
    return await gate.promise;
  });

  warmTweakStore(page);
  const render = renderStorePage(page);

  assert.equal(requests, 1);
  gate.resolve(registry([installedEntry("com.example.old", "0.1.0", "0.2.0")]));
  await render;
  assert.equal(page.publishedCounts.at(-1), 1);
});

test("a normal Store render failure clears the count and a later render retries", async () => {
  const fixture = settingsFixture();
  let requests = 0;
  const page = context(
    fixture.environment.document.createElement("div"),
    [],
    async () => {
      requests += 1;
      if (requests === 1) throw new Error("offline");
      return registry([]);
    },
  );
  page.setStoreUpdateCount(3);

  await renderStorePage(page);

  assert.equal(page.publishedCounts.at(-1), 0);
  assert.match(page.root.textContent ?? "", /Could not load Tweak Store.*offline/);
  await renderStorePage(page);
  assert.equal(requests, 2);
  assert.match(page.root.textContent ?? "", /No tweaks yet/);
});

test("a later normal warm completion remains the final cache after forced Refresh finishes first", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const warm = deferred<TweakStoreRegistryView>();
  const forced = deferred<TweakStoreRegistryView>();
  let requests = 0;
  const page = context(root, [], async (channel) => {
    assert.equal(channel, "claudepp:get-tweak-store");
    requests += 1;
    return await (requests === 1 ? warm.promise : forced.promise);
  });
  warmTweakStore(page);
  await renderStorePage(page, registry([]));

  fixture.click(findButtonByText(root, "Refresh"));
  assert.equal(requests, 2);
  forced.resolve(registry([entry("com.example.forced", "Forced Result")]));
  await flushPromises();
  warm.resolve(registry([entry("com.example.warm", "Warm Final Result")]));
  await flushPromises();

  await renderStorePage(page);
  assert.equal(requests, 2);
  assert.match(root.textContent ?? "", /Warm Final Result/);
  assert.doesNotMatch(root.textContent ?? "", /Forced Result/);
});

test("successful Store install decrements the count and invalidates the warmed cache", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  let requests = 0;
  const page = context(root, [], async (channel) => {
    if (channel === "claudepp:get-tweak-store") {
      requests += 1;
      return requests === 1
        ? registry([installedEntry("com.example.update", "0.1.0", "0.2.0")])
        : registry([]);
    }
    if (channel === "claudepp:install-store-tweak") return undefined;
    throw new Error(`unexpected ${channel}`);
  });
  warmTweakStore(page);
  await flushPromises();
  await renderStorePage(page);

  fixture.click(findButtonByText(root, "Update"));
  await flushPromises();

  assert.equal(page.publishedCounts.at(-1), 0);
  warmTweakStore(page);
  assert.equal(requests, 2);
  await flushPromises();
});

type StoreInvokeFixture = (
  channel: string,
  ...args: unknown[]
) => Promise<unknown>;

function context(
  root: HTMLElement,
  calls: string[] = [],
  invokeFixture: StoreInvokeFixture = async () => undefined,
): StorePageContext & { publishedCounts: number[] } {
  const publishedCounts: number[] = [];
  return {
    root,
    publishedCounts,
    setStoreUpdateCount(count: number) { publishedCounts.push(count); },
    promptRepo: () => null,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      if (channel === "claudepp:install-store-tweak") calls.push(String(args[0]));
      return (await invokeFixture(channel, ...args)) as T;
    },
  };
}

function registry(entries: TweakStoreEntryView[]): TweakStoreRegistryView {
  return {
    schemaVersion: 1,
    sourceUrl: "https://example.com/store.json",
    fetchedAt: "2026-08-13T00:00:00.000Z",
    entries,
  };
}

function entry(id: string, name: string, compatible = true): TweakStoreEntryView {
  return {
    id,
    manifest: {
      id,
      name,
      version: "0.2.0",
      githubRepo: "example/settings",
      description: `${name} description`,
    },
    repo: "example/settings",
    approvedCommitSha: "1234567890abcdef1234567890abcdef12345678",
    approvedAt: "2026-08-13T00:00:00.000Z",
    approvedBy: "reviewer",
    releaseUrl: "https://github.com/example/settings/releases/tag/v0.2.0",
    reviewUrl: "https://github.com/example/settings/issues/1",
    platform: { current: "win32", supported: ["win32"], compatible: true, reason: null },
    runtime: {
      current: "0.2.0",
      required: compatible ? null : "0.3.0",
      compatible,
      reason: compatible ? null : "Requires newer Claude++",
    },
    installed: null,
  };
}

function installedEntry(id: string, installed: string, latest: string): TweakStoreEntryView {
  const base = entry(id, id);
  return {
    ...base,
    manifest: { ...base.manifest, version: latest },
    installed: { version: installed, enabled: true },
  };
}

function findButtonByText(root: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(button);
  return button;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
