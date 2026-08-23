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

test("Download Update disables duplicate starts while the updater is launching", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const update = config();
  const launch = deferred();
  let launches = 0;
  await renderConfigPage(context(root, update, absentWatcher(), {
    async runUpdate() {
      launches += 1;
      await launch.promise;
      update.selfUpdate = checkingSelfUpdate();
    },
  }));
  const updates = findSectionByHeading(root, "Claude++ Updates");
  const download = findButtonByText(updates, "Download Update");

  fixture.click(download);
  fixture.click(download);

  assert.equal(download.disabled, true);
  assert.equal(download.textContent, "Starting Update…");
  assert.equal(launches, 1);
  launch.resolve();
  await flushPromises();

  const refreshedUpdates = findSectionByHeading(root, "Claude++ Updates");
  const inProgress = findButtonByText(refreshedUpdates, "Update in Progress");
  assert.equal(inProgress.disabled, true);
  assert.match(refreshedUpdates.textContent ?? "", /Checking for updates/i);
  fixture.click(inProgress);
  assert.equal(launches, 1);
});

test("Download Update restores the action and reports launch failures inline", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  await renderConfigPage(context(root, config(), absentWatcher(), {
    runUpdate: async () => {
      throw new Error("Node.js 24 or newer is required");
    },
  }));
  const updates = findSectionByHeading(root, "Claude++ Updates");
  const download = findButtonByText(updates, "Download Update");

  fixture.click(download);
  await flushPromises();

  assert.equal(download.disabled, false);
  assert.equal(download.textContent, "Download Update");
  const alert = updates.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent ?? "", /Could not start Claude\+\+ update.*Node\.js 24 or newer/i);
});

test("shows a real download percentage and progress element when total bytes are known", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const update = config();
  update.selfUpdate = {
    ...checkingSelfUpdate(),
    phase: "downloading",
    downloadedBytes: 8,
    totalBytes: 16,
  };

  await renderConfigPage(context(root, update, absentWatcher()));

  assert.match(root.textContent ?? "", /Downloading 50%.*8 B of 16 B/i);
  const progress = root.querySelector('[data-claudepp-update-progress="true"]');
  assert.ok(progress);
  assert.equal(progress.getAttribute("value"), "8");
  assert.equal(progress.getAttribute("max"), "16");
});

test("shows downloaded bytes without a percentage when total size is unknown", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  const update = config();
  update.selfUpdate = {
    ...checkingSelfUpdate(),
    phase: "downloading",
    downloadedBytes: 2048,
    totalBytes: null,
  };

  await renderConfigPage(context(root, update, absentWatcher()));

  assert.match(root.textContent ?? "", /Downloading update.*2 KB downloaded/i);
  assert.doesNotMatch(root.textContent ?? "", /\d+%/);
  assert.equal(root.querySelector('[data-claudepp-update-progress="true"]'), null);
});

test("polls an in-progress update until Config renders its terminal state", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  fixture.environment.document.body.appendChild(root);
  const update = config();
  update.selfUpdate = {
    ...checkingSelfUpdate(),
    phase: "verifying",
  };
  const timer = manualTimer();
  const teardown = await renderConfigPage(context(root, update, absentWatcher(), { timer: timer.timer }));

  assert.match(root.textContent ?? "", /Verifying update/i);
  assert.equal(timer.pending(), 1);
  update.selfUpdate = {
    ...checkingSelfUpdate(),
    completedAt: "2026-08-23T00:01:00.000Z",
    status: "up-to-date",
  };
  timer.fireNext();
  await flushPromises();

  assert.match(root.textContent ?? "", /Up to date/i);
  assert.equal(findButtonByText(root, "Download Update").disabled, false);
  assert.equal(timer.pending(), 0);
  teardown();
});

test("stops update polling when the Config page is disposed", async () => {
  const fixture = settingsFixture();
  const root = fixture.environment.document.createElement("div");
  fixture.environment.document.body.appendChild(root);
  const update = config();
  update.selfUpdate = { ...checkingSelfUpdate(), phase: "downloading" };
  const timer = manualTimer();
  const teardown = await renderConfigPage(context(root, update, absentWatcher(), { timer: timer.timer }));

  assert.equal(timer.pending(), 1);
  teardown();
  assert.equal(timer.pending(), 0);
});

function context(
  root: HTMLElement,
  update: ClaudePlusPlusConfigView,
  watcher: WatcherHealth,
  options: {
    check?: ClaudePlusPlusUpdateCheck;
    publish?(check: ClaudePlusPlusUpdateCheck | null): void;
    runUpdate?(): Promise<void>;
    timer?: ReturnType<typeof manualTimer>["timer"];
  } = {},
) {
  return {
    root,
    timer: options.timer,
    async invoke<T = unknown>(channel: string): Promise<T> {
      if (channel === "claudepp:get-config") return update as T;
      if (channel === "claudepp:get-watcher-health") return watcher as T;
      if (channel === "claudepp:check-claudepp-update") return options.check as T;
      if (channel === "claudepp:run-claudepp-update") {
        return await options.runUpdate?.() as T;
      }
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function manualTimer() {
  type Handle = { callback: () => void };
  const handles: Handle[] = [];
  return {
    timer: {
      set(callback: () => void): Handle {
        const handle = { callback };
        handles.push(handle);
        return handle;
      },
      clear(handle: Handle): void {
        const index = handles.indexOf(handle);
        if (index >= 0) handles.splice(index, 1);
      },
    },
    fireNext(): void {
      const handle = handles.shift();
      assert.ok(handle);
      handle.callback();
    },
    pending(): number {
      return handles.length;
    },
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

function checkingSelfUpdate(): NonNullable<ClaudePlusPlusConfigView["selfUpdate"]> {
  return {
    checkedAt: "2026-08-23T00:00:00.000Z",
    status: "checking",
    currentVersion: "0.3.1",
    latestVersion: null,
    targetRef: null,
    releaseUrl: null,
    repo: "kpkhxlgy0/claude-plusplus",
    channel: "stable",
    sourceRoot: "C:\\Users\\fixture\\.claude-plusplus\\source",
    sourceLabel: "Source checkout",
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
