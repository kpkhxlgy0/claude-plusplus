import assert from "node:assert/strict";
import test from "node:test";
import type {
  SettingsPage,
  TweakManifest,
} from "@claude-plusplus/sdk";
import type { ClaudePlusPlusUpdateCheck } from "../src/config.ts";
import type {
  SettingsNavigationGroup,
  SettingsShellAdapter,
} from "../src/preload/claude-settings-shell-adapter.ts";
import {
  SettingsProductController,
  type SettingsProductServices,
} from "../src/settings/product-controller.ts";
import type { SettingsProductPageContext } from "../src/settings/types.ts";
import { MiniElement, settingsFixture } from "./fixtures/settings-dom.ts";

test("orders built-in and registered navigation groups", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, fakeServices());
  controller.registerPage(
    "com.example.settings-tweak",
    manifest("com.example.settings-tweak"),
    page("prompts", "Example Tweak"),
  );
  controller.start();

  assert.deepEqual(adapter.navigation.map((group) => [
    group.title,
    group.items.map((item) => item.title),
  ]), [
    ["CLAUDE++", ["Config", "Tweaks", "Tweak Store"]],
    ["TWEAKS", ["Example Tweak"]],
  ]);
});

test("runs the active page teardown exactly once when switching to native Settings", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  let teardown = 0;
  const controller = new SettingsProductController(adapter, fakeServices());
  controller.registerPage(
    "com.example.one",
    manifest("com.example.one"),
    pageWithTeardown(() => { teardown += 1; }),
  );
  controller.start();
  controller.activate("com.example.one:page");

  adapter.emitNativeNavigation();
  adapter.emitNativeNavigation();

  assert.equal(teardown, 1);
});

test("namespaces registrations once and replaces an active page after teardown", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  let teardown = 0;
  const controller = new SettingsProductController(adapter, fakeServices());
  controller.start();
  controller.registerPage(
    "com.example.one",
    manifest("com.example.one"),
    pageWithTeardown(() => { teardown += 1; }),
  );
  controller.activate("com.example.one:page");

  const replacement = controller.registerPage(
    "com.example.one",
    manifest("com.example.one"),
    page("com.example.one:page", "Replacement"),
  );

  assert.equal(teardown, 1);
  assert.equal(adapter.activeId, "com.example.one:page");
  assert.equal(adapter.navigation[1]?.items[0]?.id, "com.example.one:page");
  replacement.unregister();
  replacement.unregister();
  assert.equal(adapter.restoreCount, 1);
});

test("renders built-in shells and contains an injected renderer error", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, {
    ...fakeServices(),
    renderConfig() {
      throw new Error("config fixture failure");
    },
  });
  controller.start();

  controller.activate("claudepp:config");

  assert.match(adapter.panelRoot?.textContent ?? "", /Claude\+\+.*config fixture failure/);
  assert.equal(adapter.panelRoot?.querySelector("[role=\"alert\"]")?.textContent,
    "Unable to load Config: config fixture failure");
});

test("clear removes Tweak registrations without leaving an active built-in page", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, fakeServices());
  controller.start();
  controller.registerPage(
    "com.example.one",
    manifest("com.example.one"),
    page("page", "Page"),
  );
  controller.activate("claudepp:tweaks");

  controller.clear();

  assert.equal(adapter.activeId, "claudepp:tweaks");
  assert.equal(adapter.restoreCount, 0);
  assert.equal(adapter.navigation.length, 1);
  assert.equal(adapter.navigation[0]?.title, "CLAUDE++");
});

test("publishes the installed Store update count in navigation", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, fakeServices());
  controller.start();

  controller.setStoreUpdateCount(2);

  assert.equal(adapter.navigation[0]?.items[2]?.badge, "2");
});

test("publishes one product Update action and removes it for current or failed results", async () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const opened: string[] = [];
  const controller = new SettingsProductController(adapter, {
    ...fakeServices(),
    async openExternal(url) { opened.push(url); },
  });
  controller.start();

  controller.setProductUpdateCheck(productCheck({
    latestVersion: "0.3.1",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
    updateAvailable: true,
  }));
  const action = adapter.navigation[0]?.headerAction;
  assert.equal(action?.label, "Update");
  assert.match(action?.title ?? "", /0\.3\.1/);
  await action?.onClick();
  assert.deepEqual(opened, [
    "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
  ]);

  controller.setProductUpdateCheck(productCheck({ releaseUrl: null }));
  const fallbackAction = adapter.navigation[0]?.headerAction;
  assert.equal(fallbackAction?.label, "Update");
  await fallbackAction?.onClick();
  assert.equal(
    opened.at(-1),
    "https://github.com/kpkhxlgy0/claude-plusplus/releases",
  );

  controller.setProductUpdateCheck(productCheck({
    latestVersion: "0.3.0",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.0",
    updateAvailable: false,
  }));
  assert.equal(adapter.navigation[0]?.headerAction, undefined);
  controller.setProductUpdateCheck(null);
  assert.equal(adapter.navigation[0]?.headerAction, undefined);
});

test("an existing action dereferences the controller's current release URL", async () => {
  const fixture = settingsFixture();
  const opened: string[] = [];
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, {
    ...fakeServices(),
    async openExternal(url) { opened.push(url); },
  });
  controller.start();
  controller.setProductUpdateCheck(availableProductCheck("https://github.com/example/first"));
  const retainedAction = adapter.navigation[0]?.headerAction;
  controller.setProductUpdateCheck(availableProductCheck("https://github.com/example/current"));
  await retainedAction?.onClick();
  assert.deepEqual(opened, ["https://github.com/example/current"]);
});

test("keeps the Store badge and product header action after either setter synchronizes navigation", () => {
  const fixture = settingsFixture();
  const adapter = new FakeSettingsShellAdapter(fixture.environment.document);
  const controller = new SettingsProductController(adapter, fakeServices());
  controller.start();
  controller.setProductUpdateCheck(availableProductCheck());

  controller.setStoreUpdateCount(2);
  assert.equal(adapter.navigation[0]?.items[2]?.badge, "2");
  assert.equal(adapter.navigation[0]?.headerAction?.label, "Update");

  controller.setProductUpdateCheck(productCheck({ latestVersion: "0.3.2" }));
  assert.equal(adapter.navigation[0]?.items[2]?.badge, "2");
  assert.equal(adapter.navigation[0]?.headerAction?.title, "Open Claude++ 0.3.2 update");
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

function page(id: string, title: string): SettingsPage {
  return {
    id,
    title,
    render(root) {
      root.textContent = title;
    },
  };
}

function pageWithTeardown(teardown: () => void): SettingsPage {
  return {
    id: "page",
    title: "Page",
    render(root) {
      root.textContent = "Page body";
      return teardown;
    },
  };
}

function fakeServices(): SettingsProductServices {
  const loading = (context: SettingsProductPageContext): void => {
    context.root.textContent = "Loading…";
  };
  return {
    renderConfig: loading,
    renderTweaks: loading,
    renderStore: loading,
    openExternal: async () => {},
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

class FakeSettingsShellAdapter implements SettingsShellAdapter {
  public navigation: SettingsNavigationGroup[] = [];
  public activeId: string | null = null;
  public panelRoot: MiniElement | null = null;
  public restoreCount = 0;
  private activateNavigation: (id: string) => void = () => {};
  private notifyNativeRestored: () => void = () => {};
  private teardown: (() => void) | null = null;

  public constructor(private readonly document: Document) {}

  public start(): void {}

  public stop(): void {
    this.restoreNative();
  }

  public setNavigationMountListener(_listener: (visible: boolean) => void): void {}

  public setVisibilityListener(_listener: (visible: boolean) => void): void {}

  public setNavigation(
    groups: SettingsNavigationGroup[],
    activate: (id: string) => void,
    nativeRestored: () => void = () => {},
  ): void {
    this.navigation = groups;
    this.activateNavigation = activate;
    this.notifyNativeRestored = nativeRestored;
  }

  public setActive(id: string | null): void {
    this.activeId = id;
  }

  public showPanel(id: string, render: (root: HTMLElement) => void | (() => void)): void {
    this.runTeardown();
    this.activeId = id;
    this.panelRoot = this.document.createElement("div") as unknown as MiniElement;
    const teardown = render(this.panelRoot as unknown as HTMLElement);
    this.teardown = typeof teardown === "function" ? teardown : null;
  }

  public restoreNative(): void {
    if (!this.activeId && !this.panelRoot && !this.teardown) return;
    this.restoreCount += 1;
    this.runTeardown();
    this.activeId = null;
    this.panelRoot = null;
    this.notifyNativeRestored();
  }

  public emitNativeNavigation(): void {
    this.restoreNative();
  }

  public activateNavigationItem(id: string): void {
    this.activateNavigation(id);
  }

  private runTeardown(): void {
    const teardown = this.teardown;
    this.teardown = null;
    teardown?.();
  }
}
