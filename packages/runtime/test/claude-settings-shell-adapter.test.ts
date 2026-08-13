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

function group(title: string, items: SettingsNavigationGroup["items"]): SettingsNavigationGroup {
  return { id: title.toLowerCase().replace(/\W+/g, "-"), title, items };
}
