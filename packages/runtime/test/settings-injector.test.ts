import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import type { ClaudePlusPlusUpdateCheck } from "../src/config.ts";
import { clearStoreCache } from "../src/settings/store-page.ts";
import type {
  TweakStoreEntryView,
  TweakStoreRegistryView,
} from "../src/tweak-store.ts";
import type { ClaudePlusPlusConfigView } from "../src/update-service.ts";
import type { WatcherHealth } from "../src/watcher-health.ts";
import {
  clearSettingsPages,
  registerPage,
  setSettingsManagementBridge,
  startSettingsInjector,
} from "../src/preload/settings-injector.ts";
import { classTokens, settingsFixture } from "./fixtures/settings-dom.ts";

const emptyStoreRegistry: TweakStoreRegistryView = {
  schemaVersion: 1,
  sourceUrl: "https://example.com/store.json",
  fetchedAt: "2026-08-22T00:00:00.000Z",
  entries: [],
};

async function baselineManagementBridge(channel: string): Promise<unknown> {
  if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
  throw new Error(`unexpected ${channel}`);
}

beforeEach(() => {
  clearStoreCache();
  setSettingsManagementBridge(baselineManagementBridge);
});
afterEach(() => {
  clearStoreCache();
  setSettingsManagementBridge(baselineManagementBridge);
});

test("registers a namespaced page, isolates native content, and restores it from native navigation", () => {
  const fixture = settingsFixture();
  const teardown = { count: 0 };
  startSettingsInjector(fixture.environment);
  registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    description: "Configure Story and Bug analysis prompts.",
    render(root) {
      root.textContent = "rendered";
      return () => { teardown.count += 1; };
    },
  });

  const injected = fixture.findPageButton("com.example.one:prompts");
  assert.ok(injected);
  fixture.click(injected);
  assert.equal(fixture.nativeHeader.style.display, "none");
  assert.equal(fixture.nativeBody.style.display, "none");
  assert.match(fixture.content.textContent, /Example Tweak.*rendered/);

  fixture.click(fixture.generalButton);
  assert.equal(fixture.nativeHeader.style.display, "grid");
  assert.equal(fixture.nativeBody.style.display, "");
  assert.equal(teardown.count, 1);
  assert.equal(fixture.findPanel(), null);
  clearSettingsPages();
});

test("moves the selected navigation state from Claude's native page to the injected page", () => {
  const fixture = settingsFixture();
  startSettingsInjector(fixture.environment);
  registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    render() {},
  });

  const injected = fixture.findPageButton("com.example.one:prompts");
  assert.ok(injected);
  fixture.click(injected);

  assert.equal(injected.getAttribute("aria-current"), "page");
  assert.deepEqual(classTokens(injected), [
    "bg-alpha-2",
    "cursor-pointer",
    "flex",
    "font-medium",
    "gap-sm",
    "h-control",
    "items-center",
    "px-sm",
    "rounded",
    "text-body",
    "text-left",
    "text-primary",
    "transition-colors",
    "w-full",
  ]);
  assert.equal(fixture.generalButton.getAttribute("aria-current"), null);
  assert.deepEqual(classTokens(fixture.generalButton), [
    "cursor-pointer",
    "flex",
    "gap-sm",
    "h-control",
    "hover:bg-fill-ghost-hover",
    "hover:text-primary",
    "items-center",
    "px-sm",
    "rounded",
    "text-body",
    "text-left",
    "text-secondary",
    "transition-colors",
    "w-full",
  ]);
  clearSettingsPages();
});

test("remounts without duplicate navigation and runs teardown once before unregister", () => {
  const fixture = settingsFixture();
  let teardownCount = 0;
  startSettingsInjector(fixture.environment);
  const handle = registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    render(root) {
      root.textContent = "first";
      return () => { teardownCount += 1; };
    },
  });
  fixture.click(fixture.findPageButton("com.example.one:prompts"));

  fixture.remountSettingsShell();
  fixture.flushMutation();
  assert.equal(fixture.countPageButtons("com.example.one:prompts"), 1);
  assert.equal(teardownCount, 1);
  assert.match(fixture.content.textContent, /first/);

  handle.unregister();
  handle.unregister();
  assert.equal(teardownCount, 2);
  assert.equal(fixture.findPageButton("com.example.one:prompts"), null);
  assert.equal(fixture.nativeHeader.style.display, "grid");
  assert.equal(fixture.nativeBody.style.display, "");
  clearSettingsPages();
});

test("does not rebuild an unchanged settings navigation group on observer ticks", () => {
  const fixture = settingsFixture();
  startSettingsInjector(fixture.environment);
  registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    render() {},
  });
  const before = fixture.findPageButton("com.example.one:prompts");

  fixture.flushMutation();

  assert.strictEqual(fixture.findPageButton("com.example.one:prompts"), before);
  clearSettingsPages();
});

test("hot registration does not reopen a page after native navigation restored Settings", () => {
  const fixture = settingsFixture();
  startSettingsInjector(fixture.environment);
  registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    render(root) {
      root.textContent = "first";
    },
  });
  fixture.click(fixture.findPageButton("com.example.one:prompts"));
  fixture.click(fixture.generalButton);

  registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    render(root) {
      root.textContent = "hot reload";
    },
  });

  assert.equal(fixture.findPanel(), null);
  assert.equal(fixture.nativeBody.style.display, "");
  clearSettingsPages();
});

test("renders the registered page icon SVG in its settings navigation item", () => {
  const fixture = settingsFixture();
  startSettingsInjector(fixture.environment);
  registerPage("com.example.one", manifest("com.example.one"), {
    id: "prompts",
    title: "Example Tweak",
    iconSvg: '<svg viewBox="0 0 20 20"><path d="M2 10h16" /></svg>',
    render() {},
  });

  const button = fixture.findPageButton("com.example.one:prompts");
  const icon = button?.querySelector("[data-claudepp-settings-icon]");
  assert.equal(icon?.innerHTML, '<svg viewBox="0 0 20 20"><path d="M2 10h16" /></svg>');
  clearSettingsPages();
});

test("contains one page render failure and still opens another registered page", () => {
  const fixture = settingsFixture();
  startSettingsInjector(fixture.environment);
  registerPage("com.example.bad", manifest("com.example.bad"), {
    id: "broken",
    title: "Broken page",
    render() {
      throw new Error("fixture failure");
    },
  });
  registerPage("com.example.good", manifest("com.example.good"), {
    id: "working",
    title: "Working page",
    render(root) {
      root.textContent = "still rendered";
    },
  });

  fixture.click(fixture.findPageButton("com.example.bad:broken"));
  assert.match(fixture.content.textContent, /Unable to render this settings page.*fixture failure/);
  fixture.click(fixture.findPageButton("com.example.good:working"));
  assert.match(fixture.content.textContent, /Working page.*still rendered/);
  assert.doesNotMatch(fixture.content.textContent, /fixture failure/);
  clearSettingsPages();
});

test("an initially visible navigation mount starts product and Store before injector returns", async () => {
  const fixture = settingsFixture();
  const product = deferred<ClaudePlusPlusUpdateCheck>();
  const store = deferred<TweakStoreRegistryView>();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") {
      assert.ok(fixture.findPageButton("claudepp:config"));
      return await product.promise;
    }
    if (channel === "claudepp:get-tweak-store") return await store.promise;
    throw new Error(`unexpected ${channel}`);
  });

  startSettingsInjector(fixture.environment);

  assert.ok(fixture.findPageButton("claudepp:config"));
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);
  product.resolve(currentProductCheck());
  store.resolve(storeRegistry([installedStoreEntry("com.example.update", "0.1.0", "0.2.0")]));
  await flushPromises();
  assert.equal(storeBadgeText(fixture.environment.document), "1");
});

test("a hidden navigation mount defers product metadata and Store warm until first visibility", async () => {
  const fixture = settingsFixture({ display: "none" });
  const product = deferred<ClaudePlusPlusUpdateCheck>();
  const store = deferred<TweakStoreRegistryView>();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") return await product.promise;
    if (channel === "claudepp:get-tweak-store") return await store.promise;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);
  assert.ok(fixture.findPageButton("claudepp:config"));
  assert.deepEqual(calls, []);

  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushAttributeMutation();
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);
  assert.ok(fixture.findPageButton("claudepp:config"));
  product.resolve(availableProductCheck());
  store.resolve(emptyStoreRegistry);
  await flushPromises();
  assert.equal(fixture.countGroupActions("claudepp-update"), 1);
});

test("hidden to visible transitions reuse the Renderer Store cache", async () => {
  const fixture = settingsFixture({ display: "none" });
  let productRequests = 0;
  let storeRequests = 0;
  setSettingsManagementBridge(async (channel) => {
    if (channel === "claudepp:check-claudepp-update") {
      productRequests += 1;
      return currentProductCheck();
    }
    if (channel === "claudepp:get-tweak-store") {
      storeRequests += 1;
      return emptyStoreRegistry;
    }
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);

  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushAttributeMutation();
  await flushPromises();
  fixture.setDialogStyle({ display: "none", visibility: "visible" });
  fixture.flushAttributeMutation();
  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushAttributeMutation();
  await flushPromises();

  assert.equal(productRequests, 1);
  assert.equal(storeRequests, 1);
});

test("a direct visible shell replacement checks product metadata for the new mount", async () => {
  const fixture = settingsFixture();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") return currentProductCheck();
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);
  await flushPromises();
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);

  fixture.replaceVisibleSettingsShell();
  fixture.flushMutation();
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
    "claudepp:check-claudepp-update",
  ]);
});

test("same-shell observer and visibility noise does not repeat a mounted product check", async () => {
  const fixture = settingsFixture();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") return currentProductCheck();
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);
  await flushPromises();

  fixture.flushMutation();
  fixture.setDialogStyle({ display: "none", visibility: "visible" });
  fixture.flushAttributeMutation();
  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushAttributeMutation();
  fixture.flushResize();
  fixture.flushWindowResize();

  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);
  assert.ok(fixture.findPageButton("claudepp:config"));
});

test("a recreated owned group checks only when that mount becomes visible", async () => {
  const fixture = settingsFixture();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") return currentProductCheck();
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);
  await flushPromises();

  fixture.setDialogStyle({ display: "none", visibility: "visible" });
  fixture.flushAttributeMutation();
  fixture.removeInjectedSettingsGroups();
  fixture.flushMutation();
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);
  assert.ok(fixture.findPageButton("claudepp:config"));

  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushAttributeMutation();
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
    "claudepp:check-claudepp-update",
  ]);
});

test("an automatic product IPC rejection clears the action without removing navigation", async () => {
  const fixture = settingsFixture();
  let productCalls = 0;
  setSettingsManagementBridge(async (channel) => {
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    if (channel !== "claudepp:check-claudepp-update") throw new Error(`unexpected ${channel}`);
    productCalls += 1;
    if (productCalls === 1) return availableProductCheck();
    throw new Error("fixture product check failure");
  });
  startSettingsInjector(fixture.environment);
  await flushPromises();
  assert.equal(fixture.countGroupActions("claudepp-update"), 1);

  fixture.replaceVisibleSettingsShell();
  fixture.flushMutation();
  await flushPromises();

  assert.equal(fixture.countGroupActions("claudepp-update"), 0);
  assert.ok(fixture.findPageButton("claudepp:config"));
});

test("an old document's automatic completion cannot publish into a replacement environment", async () => {
  const fixtureA = settingsFixture();
  const automaticA = deferred<ClaudePlusPlusUpdateCheck>();
  const calls: string[] = [];
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    if (channel === "claudepp:check-claudepp-update") return await automaticA.promise;
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixtureA.environment);
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);

  const fixtureB = settingsFixture({ display: "none" });
  setSettingsManagementBridge(async (channel) => {
    calls.push(channel);
    throw new Error(`unexpected replacement call ${channel}`);
  });
  startSettingsInjector(fixtureB.environment);
  automaticA.resolve(availableProductCheck());
  await flushPromises();

  assert.equal(fixtureA.countGroupActions("claudepp-update"), 0);
  assert.equal(fixtureB.countGroupActions("claudepp-update"), 0);
  assert.deepEqual(calls, [
    "claudepp:check-claudepp-update",
    "claudepp:get-tweak-store",
  ]);
});

test("an old document Store completion cannot publish into a hidden replacement environment", async () => {
  const fixtureA = settingsFixture();
  const storeA = deferred<TweakStoreRegistryView>();
  let storeRequests = 0;
  setSettingsManagementBridge(async (channel) => {
    if (channel === "claudepp:check-claudepp-update") return currentProductCheck();
    if (channel === "claudepp:get-tweak-store") {
      storeRequests += 1;
      return await storeA.promise;
    }
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixtureA.environment);

  const fixtureB = settingsFixture({ display: "none" });
  setSettingsManagementBridge(async (channel) => {
    if (channel === "claudepp:check-claudepp-update") return currentProductCheck();
    if (channel === "claudepp:get-tweak-store") {
      storeRequests += 1;
      return emptyStoreRegistry;
    }
    throw new Error(`unexpected replacement call ${channel}`);
  });
  startSettingsInjector(fixtureB.environment);
  storeA.resolve(storeRegistry([installedStoreEntry("com.example.old", "0.1.0", "0.2.0")]));
  await flushPromises();

  assert.equal(storeBadgeText(fixtureA.environment.document), null);
  assert.equal(storeBadgeText(fixtureB.environment.document), null);
  fixtureB.setDialogStyle({ display: "block", visibility: "visible" });
  fixtureB.flushAttributeMutation();
  await flushPromises();
  assert.equal(storeRequests, 1);
  assert.equal(storeBadgeText(fixtureB.environment.document), "1");
});

test("an old Config forced completion cannot publish or rerender after environment replacement", async () => {
  const fixtureA = settingsFixture();
  const forcedA = deferred<ClaudePlusPlusUpdateCheck>();
  const calls: Array<[string, ...unknown[]]> = [];
  setSettingsManagementBridge(async (channel, ...args) => {
    calls.push([channel, ...args]);
    if (channel === "claudepp:check-claudepp-update" && args[0] === false) {
      return currentProductCheck();
    }
    if (channel === "claudepp:check-claudepp-update" && args[0] === true) {
      return await forcedA.promise;
    }
    if (channel === "claudepp:get-config") return configView();
    if (channel === "claudepp:get-watcher-health") return absentWatcher();
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixtureA.environment);
  fixtureA.click(fixtureA.findPageButton("claudepp:config"));
  await flushPromises();
  const oldRoot = fixtureA.findPanel();
  assert.ok(oldRoot);
  const updates = findSectionByHeading(oldRoot as unknown as HTMLElement, "Claude++ Updates");
  fixtureA.click(findButtonByText(updates, "Check Now"));
  const oldText = oldRoot.textContent;

  const fixtureB = settingsFixture({ display: "none" });
  startSettingsInjector(fixtureB.environment);
  const callCountBeforeSettlement = calls.length;
  forcedA.resolve(availableProductCheck());
  await flushPromises();

  assert.equal(fixtureB.countGroupActions("claudepp-update"), 0);
  assert.equal(oldRoot.textContent, oldText);
  assert.equal(calls.length, callCountBeforeSettlement);
});

test("automatic and forced product checks publish strictly in completion order", async () => {
  const automaticFirst = deferred<ClaudePlusPlusUpdateCheck>();
  const forcedSecond = deferred<ClaudePlusPlusUpdateCheck>();
  const visible = settingsFixture();
  setSettingsManagementBridge(productBridge(automaticFirst, forcedSecond));
  startSettingsInjector(visible.environment);
  visible.click(visible.findPageButton("claudepp:config"));
  await flushPromises();
  const visiblePanel = visible.findPanel();
  assert.ok(visiblePanel);
  visible.click(findButtonByText(
    findSectionByHeading(visiblePanel as unknown as HTMLElement, "Claude++ Updates"),
    "Check Now",
  ));

  forcedSecond.resolve(productCheck({ latestVersion: "0.3.2" }));
  await flushPromises();
  assert.equal(visible.countGroupActions("claudepp-update"), 1);
  automaticFirst.resolve(currentProductCheck());
  await flushPromises();
  assert.equal(visible.countGroupActions("claudepp-update"), 0);

  const forcedFirst = deferred<ClaudePlusPlusUpdateCheck>();
  const automaticSecond = deferred<ClaudePlusPlusUpdateCheck>();
  const hidden = settingsFixture({ display: "none" });
  setSettingsManagementBridge(productBridge(automaticSecond, forcedFirst));
  startSettingsInjector(hidden.environment);
  hidden.click(hidden.findPageButton("claudepp:config"));
  await flushPromises();
  const hiddenPanel = hidden.findPanel();
  assert.ok(hiddenPanel);
  hidden.click(findButtonByText(
    findSectionByHeading(hiddenPanel as unknown as HTMLElement, "Claude++ Updates"),
    "Check Now",
  ));
  hidden.setDialogStyle({ display: "block", visibility: "visible" });
  hidden.flushAttributeMutation();

  automaticSecond.resolve(availableProductCheck());
  await flushPromises();
  assert.equal(hidden.countGroupActions("claudepp-update"), 1);
  forcedFirst.resolve(currentProductCheck());
  await flushPromises();
  assert.equal(hidden.countGroupActions("claudepp-update"), 0);
});

test("the production Update action only opens its current release target", async () => {
  const calls: unknown[] = [];
  const fixture = settingsFixture();
  setSettingsManagementBridge(async (channel, ...args) => {
    calls.push(channel, ...args);
    if (channel === "claudepp:check-claudepp-update") return availableProductCheck();
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    if (channel === "claudepp:open-external") return undefined;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fixture.environment);
  await flushPromises();
  const beforeClick = calls.length;
  fixture.click(fixture.groupAction("claudepp-update"));
  await flushPromises();
  assert.deepEqual(calls.slice(beforeClick), [
    "claudepp:open-external",
    "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
  ]);
  assertNoUpdateSideEffects(calls);

  const fallbackCalls: unknown[] = [];
  const fallbackFixture = settingsFixture();
  setSettingsManagementBridge(async (channel, ...args) => {
    fallbackCalls.push(channel, ...args);
    if (channel === "claudepp:check-claudepp-update") {
      return productCheck({ releaseUrl: null });
    }
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    if (channel === "claudepp:open-external") return undefined;
    throw new Error(`unexpected ${channel}`);
  });
  startSettingsInjector(fallbackFixture.environment);
  await flushPromises();
  const fallbackBeforeClick = fallbackCalls.length;
  fallbackFixture.click(fallbackFixture.groupAction("claudepp-update"));
  await flushPromises();
  assert.deepEqual(fallbackCalls.slice(fallbackBeforeClick), [
    "claudepp:open-external",
    "https://github.com/kpkhxlgy0/claude-plusplus/releases",
  ]);
  assertNoUpdateSideEffects(fallbackCalls);
});

function manifest(id: string): TweakManifest {
  return {
    id,
    name: id,
    version: "0.2.0",
    githubRepo: "example/settings",
    permissions: ["settings"],
  };
}

function productCheck(
  overrides: Partial<ClaudePlusPlusUpdateCheck> = {},
): ClaudePlusPlusUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    currentVersion: "0.3.0",
    latestVersion: "0.3.1",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
    releaseNotes: null,
    updateAvailable: true,
    ...overrides,
  };
}

function availableProductCheck(
  releaseUrl = "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
): ClaudePlusPlusUpdateCheck {
  return productCheck({ releaseUrl });
}

function currentProductCheck(): ClaudePlusPlusUpdateCheck {
  return productCheck({
    latestVersion: "0.3.0",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.0",
    updateAvailable: false,
  });
}

function storeRegistry(entries: TweakStoreEntryView[]): TweakStoreRegistryView {
  return {
    ...emptyStoreRegistry,
    entries,
  };
}

function installedStoreEntry(
  id: string,
  installed: string,
  latest: string,
): TweakStoreEntryView {
  return {
    id,
    manifest: {
      id,
      name: id,
      version: latest,
      githubRepo: "example/settings",
      description: `${id} description`,
    },
    repo: "example/settings",
    approvedCommitSha: "1234567890abcdef1234567890abcdef12345678",
    approvedAt: "2026-08-22T00:00:00.000Z",
    approvedBy: "reviewer",
    releaseUrl: `https://github.com/example/settings/releases/tag/v${latest}`,
    reviewUrl: "https://github.com/example/settings/issues/1",
    platform: { current: "win32", supported: ["win32"], compatible: true, reason: null },
    runtime: { current: "0.3.0", required: null, compatible: true, reason: null },
    installed: { version: installed, enabled: true },
  };
}

function storeBadgeText(document: Document): string | null {
  return document.querySelector<HTMLElement>(
    '[data-claudepp-settings-badge="claudepp:store"]',
  )?.textContent ?? null;
}

function configView(): ClaudePlusPlusConfigView {
  return {
    version: "0.3.0",
    autoUpdate: false,
    updateChannel: "stable",
    updateRepo: "kpkhxlgy0/claude-plusplus",
    updateRef: "",
    installationSource: { label: "Packaged Windows release", detail: "Bundled Node.js runtime" },
    updateCheck: null,
    selfUpdate: null,
  };
}

function absentWatcher(): WatcherHealth {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    status: "warn",
    title: "Auto-repair Watcher is not installed",
    summary: "Watcher is not installed.",
    watcher: "none",
    installed: false,
    autoUpdate: false,
    autoUpdateAvailable: false,
    checks: [],
  };
}

function productBridge(
  automatic: Deferred<ClaudePlusPlusUpdateCheck>,
  forced: Deferred<ClaudePlusPlusUpdateCheck>,
): (channel: string, ...args: unknown[]) => Promise<unknown> {
  return async (channel, ...args) => {
    if (channel === "claudepp:check-claudepp-update") {
      return await (args[0] === true ? forced.promise : automatic.promise);
    }
    if (channel === "claudepp:get-config") return configView();
    if (channel === "claudepp:get-watcher-health") return absentWatcher();
    if (channel === "claudepp:get-tweak-store") return emptyStoreRegistry;
    throw new Error(`unexpected ${channel}`);
  };
}

function findSectionByHeading(root: HTMLElement, label: string): HTMLElement {
  const section = Array.from(root.querySelectorAll<HTMLElement>("section"))
    .find((candidate) => candidate.textContent?.trim().startsWith(label));
  assert.ok(section);
  return section;
}

function findButtonByText(root: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(button);
  return button;
}

function assertNoUpdateSideEffects(calls: readonly unknown[]): void {
  const forbidden = calls.filter((call): call is string => typeof call === "string")
    .filter((channel) =>
      channel === "claudepp:run-claudepp-update" ||
      channel === "claudepp:install-store-tweak" ||
      /watcher|spawn|archive/i.test(channel));
  assert.deepEqual(forbidden, []);
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
