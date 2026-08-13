import assert from "node:assert/strict";
import test from "node:test";
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

function context(root: HTMLElement, update: ClaudePlusPlusConfigView, watcher: WatcherHealth) {
  return {
    root,
    async invoke(channel: string) {
      if (channel === "claudepp:get-config") return update;
      if (channel === "claudepp:get-watcher-health") return watcher;
      return undefined;
    },
  };
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
