import assert from "node:assert/strict";
import test from "node:test";
import {
  createClaudeSettingsShellAdapter,
  type SettingsNavigationGroup,
} from "../src/preload/claude-settings-shell-adapter.ts";
import { settingsFixture } from "./fixtures/settings-dom.ts";

test("mounts two product groups with Claude-native button classes", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([
    group("CLAUDE++", [{ id: "config", title: "Config" }]),
    group("TWEAKS", [{ id: "example", title: "Example Tweak" }]),
  ], () => {});

  assert.equal(fixture.groupLabels().join("|"), "CLAUDE++|TWEAKS");
  assert.equal(fixture.button("config")?.className, fixture.claudeCodeButton.className);
  adapter.stop();
});

test("restores native content and remounts once after dialog recreation", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", (root) => {
    root.textContent = "Config body";
  });

  fixture.remountSettingsShell();
  fixture.flushMutation();
  assert.equal(fixture.countButtons("config"), 1);
  fixture.click(fixture.generalButton);
  assert.equal(fixture.findPanel(), null);
  assert.equal(fixture.nativeBody.style.display, "");
  adapter.stop();
});

test("stop and native restoration tear down an active panel only once", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  let teardownCount = 0;
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => () => {
    teardownCount += 1;
  });

  adapter.restoreNative();
  adapter.restoreNative();
  adapter.stop();
  adapter.stop();

  assert.equal(teardownCount, 1);
  assert.equal(fixture.findPanel(), null);
  assert.equal(fixture.nativeHeader.style.display, "grid");
});

test("reports only connected displayed visible positive-area transitions", () => {
  const fixture = settingsFixture({ display: "none", width: 800, height: 600 });
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const states: boolean[] = [];
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));
  assert.deepEqual(states, [false]);

  fixture.setDialogStyle({ display: "block", visibility: "hidden" });
  fixture.flushAttributeMutation();
  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.setDialogRect(0, 600);
  fixture.flushResize();
  assert.deepEqual(states, [false]);

  fixture.setDialogRect(800, 600);
  fixture.flushResize();
  fixture.flushWindowResize();
  fixture.flushMutation();
  assert.deepEqual(states, [false, true]);

  fixture.removeSettingsShell();
  fixture.flushMutation();
  assert.deepEqual(states, [false, true, false]);
  adapter.stop();
});

test("a direct visible shell replacement does not invent another visible transition", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const states: boolean[] = [];
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));
  fixture.replaceVisibleSettingsShell();
  fixture.flushMutation();
  assert.deepEqual(states, [true]);
  adapter.stop();
});

test("re-evaluates visibility from attribute, element resize, and window resize signals", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const states: boolean[] = [];
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));

  fixture.setDialogStyle({ display: "none", visibility: "visible" });
  fixture.flushAttributeMutation();
  fixture.setDialogStyle({ display: "block", visibility: "visible" });
  fixture.flushResize();
  fixture.setDialogRect(0, 600);
  fixture.flushWindowResize();

  assert.deepEqual(states, [true, false, true, false]);
  assert.deepEqual(fixture.mutationObservation(), {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
  });
  adapter.stop();
});

test("stop disconnects visual observers and ignores later public signal flushes", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const states: boolean[] = [];
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));
  assert.equal(fixture.activeMutationObserverCount(), 1);
  assert.equal(fixture.activeResizeObserverCount(), 1);
  assert.equal(fixture.windowListenerCount("resize"), 1);

  adapter.stop();
  assert.equal(fixture.activeMutationObserverCount(), 0);
  assert.equal(fixture.activeResizeObserverCount(), 0);
  assert.equal(fixture.windowListenerCount("resize"), 0);
  fixture.setDialogStyle({ display: "none", visibility: "hidden" });
  fixture.setDialogRect(0, 0);
  fixture.flushAttributeMutation();
  fixture.flushResize();
  fixture.flushWindowResize();
  fixture.flushMutation();
  assert.deepEqual(states, [true]);
});

test("reports navigation mount state only after attached groups are created or recovered", () => {
  const fixture = settingsFixture({ display: "none" });
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const mounts: boolean[] = [];
  adapter.setNavigationMountListener((visible) => {
    assert.equal(fixture.countButtons("config"), 1);
    mounts.push(visible);
  });
  adapter.start();
  assert.deepEqual(mounts, []);

  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  assert.deepEqual(mounts, [false]);
  adapter.setNavigation([{
    ...group("CLAUDE++", [{ id: "config", title: "Config" }]),
    headerAction: {
      id: "update",
      label: "Update",
      title: "Review Claude++ v0.3.1",
      onClick: () => {},
    },
  }], () => {});
  assert.equal(fixture.countGroupActions("update"), 1);
  fixture.flushMutation();
  assert.deepEqual(mounts, [false]);

  fixture.removeInjectedSettingsGroups();
  fixture.flushMutation();
  assert.deepEqual(mounts, [false, false]);

  fixture.replaceVisibleSettingsShell();
  fixture.flushMutation();
  assert.deepEqual(mounts, [false, false, true]);
  adapter.stop();
});

test("same-shell class observation does not self-reschedule", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  fixture.discardQueuedMutations();

  const button = fixture.button("config");
  assert.ok(button);
  fixture.queueObservedClassMutation(button);
  assert.deepEqual(fixture.drainQueuedMutations(4), { turns: 1, pending: false });
  adapter.stop();
});

test("renders one generic group-header action and uses its current callback", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const calls: string[] = [];
  adapter.start();
  adapter.setNavigation([{
    id: "claudepp",
    title: "CLAUDE++",
    headerAction: {
      id: "update",
      label: "Update",
      title: "Review Claude++ v0.3.1",
      onClick: () => { calls.push("first"); },
    },
    items: [{ id: "config", title: "Config" }],
  }], () => {});

  const button = fixture.groupAction("update");
  assert.equal(button?.textContent, "Update");
  assert.equal(button?.title, "Review Claude++ v0.3.1");
  assert.equal(button?.getAttribute("aria-label"), "Review Claude++ v0.3.1");
  assert.equal(button?.style.background, "#0A84FF");

  adapter.setNavigation([{
    id: "claudepp",
    title: "CLAUDE++",
    headerAction: {
      id: "update",
      label: "Update",
      title: "Review Claude++ v0.3.1",
      onClick: () => { calls.push("current"); },
    },
    items: [{ id: "config", title: "Config" }],
  }], () => {});
  assert.equal(fixture.groupAction("update"), button);
  fixture.click(button);
  assert.deepEqual(calls, ["current"]);
  assert.equal(fixture.countGroupActions("update"), 1);
  adapter.stop();
});

function group(title: string, items: SettingsNavigationGroup["items"]): SettingsNavigationGroup {
  return { id: title.toLowerCase().replace(/\W+/g, "-"), title, items };
}
