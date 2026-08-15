import assert from "node:assert/strict";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import { renderTweaksPage } from "../src/settings/tweaks-page.ts";
import type {
  ListedTweakView,
  RegisteredSettingsPage,
  RegisteredSettingsSection,
} from "../src/settings/types.ts";
import { MiniElement, settingsFixture } from "./fixtures/settings-dom.ts";

test("renders disabled and missing-entry Tweaks with the expected actions", () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");

  renderTweaksPage(context(root, [
    listed("com.example.disabled", "Disabled Tweak", { enabled: false }),
    listed("com.example.missing", "Missing entry Tweak", { entryExists: false }),
  ]));

  assert.match(root.textContent ?? "", /Disabled Tweak.*Missing entry Tweak/);
  assert.equal(root.querySelectorAll("[data-claudepp-tweak-toggle]").length, 2);
});

test("shows Configure, Review Release, inline settings, and a resolved icon", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const tweak = listed("com.example.configurable", "Configurable Tweak", {
    manifest: {
      iconUrl: "icon.png",
      description: "Fixture description",
      author: "Fixture Author",
      homepage: "https://example.com/tweak",
      tags: ["workflow"],
    },
    update: {
      checkedAt: "2026-08-13T00:00:00.000Z",
      repo: "example/settings",
      currentVersion: "0.2.0",
      latestVersion: "0.3.0",
      latestTag: "v0.3.0",
      releaseUrl: "https://github.com/example/settings/releases/tag/v0.3.0",
      updateAvailable: true,
    },
  });
  const sections: RegisteredSettingsSection[] = [{
    id: "com.example.configurable:inline",
    tweakId: "com.example.configurable",
    section: {
      id: "inline",
      title: "Prompt template",
      render(sectionRoot) {
        sectionRoot.textContent = "Prompt template value";
      },
    },
  }];
  const pages: RegisteredSettingsPage[] = [{
    id: "com.example.configurable:prompts",
    tweakId: "com.example.configurable",
    manifest: tweak.manifest,
    page: { id: "prompts", title: "Prompt settings", render() {} },
  }];

  renderTweaksPage(context(root, [tweak], sections, pages));
  await Promise.resolve();

  assert.match(root.textContent ?? "", /Configure.*Review Release.*Prompt template value/);
  const image = root.querySelector("img") as unknown as MiniElement;
  assert.equal(image.getAttribute("src"), "data:image/png;base64,fixture");
  assert.equal(image.style.display, "none");
  assert.equal(image.parentElement?.textContent, "C");

  image.emit("load", event(image));
  assert.equal(image.style.display, "block");
  assert.equal(image.parentElement?.textContent, "");
});

test("keeps the Tweak icon fallback when the resolved image fails to load", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  renderTweaksPage(context(root, [listed("com.example.broken", "Broken Icon", {
    manifest: { iconUrl: "icon.png" },
  })]));
  await Promise.resolve();

  const image = root.querySelector("img") as unknown as MiniElement;
  assert.equal(image.parentElement?.textContent, "B");
  image.emit("error", event(image));
  assert.equal(root.querySelector("img"), null);
  assert.match(root.textContent ?? "", /^Broken Icon|B/);
});

function event(target: MiniElement) {
  return {
    target,
    preventDefault() {},
    stopPropagation() {},
  };
}

function context(
  root: HTMLElement,
  listedTweaks: ListedTweakView[],
  sections: RegisteredSettingsSection[] = [],
  pages: RegisteredSettingsPage[] = [],
) {
  return {
    root,
    listedTweaks,
    sections,
    pages,
    activate() {},
    tweaksPath: "D:\\Tweaks",
    invoke: async () => undefined,
    resolveIcon: async () => "data:image/png;base64,fixture",
  };
}

function listed(
  id: string,
  name: string,
  overrides: {
    enabled?: boolean;
    entryExists?: boolean;
    manifest?: Partial<TweakManifest>;
    update?: ListedTweakView["update"];
  } = {},
): ListedTweakView {
  return {
    dir: `D:\\Tweaks\\${id}`,
    entry: `D:\\Tweaks\\${id}\\index.js`,
    entryExists: overrides.entryExists ?? true,
    compatible: true,
    manifest: {
      id,
      name,
      version: "0.2.0",
      githubRepo: "example/settings",
      scope: "renderer",
      ...overrides.manifest,
    },
    enabled: overrides.enabled ?? true,
    update: overrides.update ?? null,
  };
}
