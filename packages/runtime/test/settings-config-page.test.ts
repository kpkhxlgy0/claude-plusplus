import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudePlusPlusUpdateCheck } from "../src/config.ts";
import type { ClaudePlusPlusConfigView } from "../src/update-service.ts";
import type { WatcherHealth } from "../src/watcher-health.ts";
import {
  renderConfigPage,
  renderReleaseNotesMarkdown,
} from "../src/settings/config-page.ts";
import { settingsFixture } from "./fixtures/settings-dom.ts";

test("disables automatic refresh until Watcher is installed", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  await renderConfigPage(context(root, config(), absentWatcher()));

  const toggle = root.querySelector("[data-claudepp-auto-update]");
  assert.equal(toggle?.disabled, true);
  assert.match(root.textContent ?? "", /Enable Watcher.*automatic refresh/i);
});

test("shows the Custom Node.js trust warning", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  await renderConfigPage(context(root, {
    ...config(),
    updateChannel: "custom",
    updateRepo: "example/claude-plusplus",
    updateRef: "feature",
  }, absentWatcher()));

  assert.match(root.textContent ?? "", /arbitrary GitHub source.*Node\.js/i);
});

test("renders release-note lists and unfinished fenced code without HTML injection", () => {
  const fixture = settingsFixture();
  const root = renderReleaseNotesMarkdown(
    fixture.environment.document,
    "## Changes\n\n- first\n- **second**\n\n```text\n<script>alert(1)</script>",
  );

  assert.equal(root.querySelectorAll("ul").length, 1);
  assert.equal(root.querySelectorAll("li").length, 2);
  assert.equal(root.querySelectorAll("pre").length, 1);
  assert.match(root.textContent ?? "", /<script>alert\(1\)<\/script>/);
  assert.equal(root.querySelector("script"), null);
});

test("Check Now publishes the forced product result before rerendering Config", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const published: ClaudePlusPlusUpdateCheck[] = [];
  const page = context(root, config(), absentWatcher(), {
    check: availableProductCheck(),
    publish(check) { if (check) published.push(check); },
  });
  await renderConfigPage(page);
  const updates = findSectionByHeading(root, "Claude++ Updates");
  fixture.click(findButtonByText(updates, "Check Now"));
  await flushPromises();
  assert.equal(published.at(-1)?.latestVersion, "0.3.1");
});

function context(
  root: HTMLElement,
  update: ClaudePlusPlusConfigView,
  watcher: WatcherHealth,
  options: {
    check?: ClaudePlusPlusUpdateCheck;
    publish?(check: ClaudePlusPlusUpdateCheck | null): void;
  } = {},
) {
  return {
    root,
    async invoke<T = unknown>(channel: string): Promise<T> {
      if (channel === "claudepp:get-config") return update as T;
      if (channel === "claudepp:get-watcher-health") return watcher as T;
      if (channel === "claudepp:check-claudepp-update") return options.check as T;
      return undefined as T;
    },
    publishProductUpdate: options.publish ?? (() => {}),
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

function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
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

function config(): ClaudePlusPlusConfigView {
  return {
    version: "0.2.0",
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
    checkedAt: "2026-08-13T00:00:00.000Z",
    status: "warn",
    title: "Auto-repair Watcher is not installed",
    summary: "Watcher is not installed. Enable it before automatic refresh can be used.",
    watcher: "none",
    installed: false,
    autoUpdate: false,
    autoUpdateAvailable: false,
    checks: [],
  };
}
