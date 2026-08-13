import assert from "node:assert/strict";
import test from "node:test";
import type {
  SettingsPage,
  TweakManifest,
} from "@claude-plusplus/sdk";
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
  };
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
