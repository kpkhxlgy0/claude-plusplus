import assert from "node:assert/strict";
import test from "node:test";
import type {
  TweakStoreEntryView,
  TweakStoreRegistryView,
} from "../src/tweak-store.ts";
import { renderStorePage } from "../src/settings/store-page.ts";
import { settingsFixture } from "./fixtures/settings-dom.ts";

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

function context(root: HTMLElement, calls: string[] = []) {
  return {
    root,
    setStoreUpdateCount() {},
    promptRepo: () => null,
    async invoke(channel: string, ...args: unknown[]) {
      if (channel === "claudepp:install-store-tweak") calls.push(String(args[0]));
      return undefined;
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
