import assert from "node:assert/strict";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import {
  clearSettingsPages,
  registerPage,
  startSettingsInjector,
} from "../src/preload/settings-injector.ts";
import { classTokens, settingsFixture } from "./fixtures/settings-dom.ts";

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

function manifest(id: string): TweakManifest {
  return {
    id,
    name: id,
    version: "0.2.0",
    githubRepo: "example/settings",
    permissions: ["settings"],
  };
}
