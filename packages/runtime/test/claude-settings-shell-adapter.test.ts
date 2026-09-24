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

test("uses native group spacing and keeps custom icons beside truncated long labels", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("TWEAKS", [{
    id: "long-title",
    title: "A very long Tweak name that must stay inside the settings sidebar",
    iconSvg: '<svg width="20" height="20"></svg>',
  }])], () => {});

  const button = fixture.button("long-title");
  assert.ok(button);
  const list = button.parentElement?.parentElement;
  const container = list?.parentElement;
  const heading = container?.children[0];
  const icon = button.children[0];
  const label = button.children[1];
  assert.equal(container?.className, "flex flex-col gap-sm");
  assert.equal(list?.className, fixture.nativeList.className);
  for (const token of fixture.nativeHeading.className.split(" ")) {
    assert.ok(heading?.className.split(" ").includes(token), `missing heading class ${token}`);
  }
  assert.equal(button.className, fixture.claudeCodeButton.className);
  assert.equal(icon.className, fixture.nativeIcon.className);
  assert.equal(icon.style.width, "20px");
  assert.equal(icon.style.height, "20px");
  assert.equal(icon.innerHTML, '<svg width="20" height="20"></svg>');
  assert.equal(label.className, fixture.nativeLabel.className);
  assert.equal(label.textContent, "A very long Tweak name that must stay inside the settings sidebar");
  adapter.stop();
});

for (const selectedStyle of ["current", "legacy"] as const) {
  test(`cleans a cloned ${selectedStyle} selection before activating the injected row`, () => {
    const fixture = settingsFixture({ selectedButton: "claude-code", selectedStyle });
    const adapter = createClaudeSettingsShellAdapter(fixture.environment);
    adapter.start();
    adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});

    const button = fixture.button("config");
    assert.ok(button);
    assert.ok(!button.className.includes("bg-fill-ghost-selected"));
    assert.ok(!button.className.includes("bg-alpha-2"));
    adapter.showPanel("config", () => {});

    assert.ok(button.className.includes("bg-fill-ghost-selected"));
    assert.ok(!button.className.includes("bg-alpha-2"));
    assert.equal(button.getAttribute("aria-current"), "page");
    assert.ok(!fixture.claudeCodeButton.className.includes("bg-fill-ghost-selected"));
    assert.ok(!fixture.claudeCodeButton.className.includes("bg-alpha-2"));
    assert.equal(fixture.claudeCodeButton.getAttribute("aria-current"), null);

    fixture.selectNativeButton("general");
    fixture.click(fixture.generalButton);
    assert.ok(!button.className.includes("bg-fill-ghost-selected"));
    assert.equal(button.getAttribute("aria-current"), null);
    assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
    assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
    adapter.stop();
  });
}

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

test("programmatic return restores the native selection and keeps unrelated class updates", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});
  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), null);

  fixture.generalButton.className += " ring-2";
  adapter.restoreNative();

  assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.ok(fixture.generalButton.className.includes("ring-2"));
  assert.ok(!fixture.generalButton.className.includes("hover:bg-fill-ghost-hover"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
  assert.equal(fixture.findPanel(), null);
  fixture.discardQueuedMutations();
  fixture.queueObservedClassMutation(fixture.generalButton);
  assert.deepEqual(fixture.drainQueuedMutations(4), { turns: 1, pending: false });
  adapter.stop();
});

test("stop restores a class-selected native row without inventing aria-current", () => {
  const fixture = settingsFixture();
  fixture.generalButton.removeAttribute("aria-current");
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  adapter.stop();

  assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), null);
  assert.equal(fixture.findPanel(), null);
});

test("programmatic return preserves legacy selected tokens and the original aria-current value", () => {
  const fixture = settingsFixture({ selectedStyle: "legacy" });
  fixture.generalButton.setAttribute("aria-current", "step");
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  adapter.restoreNative();

  assert.ok(fixture.generalButton.className.includes("bg-alpha-2"));
  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), "step");
  adapter.stop();
});

test("removing an active custom page restores the native selected row", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  adapter.setNavigation([], () => {});

  assert.equal(fixture.findPanel(), null);
  assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
  adapter.stop();
});

test("rebuilding only the injected group keeps the native selection for later return", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  fixture.removeInjectedSettingsGroups();
  fixture.flushMutation();
  adapter.restoreNative();

  assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
  adapter.stop();
});

test("latest native selection observed while custom page is active is restored", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  fixture.selectNativeButton("claude-code");
  fixture.flushMutation();
  assert.ok(!fixture.claudeCodeButton.className.includes("bg-fill-ghost-selected"));
  adapter.restoreNative();

  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.ok(fixture.claudeCodeButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.claudeCodeButton.getAttribute("aria-current"), "page");
  adapter.stop();
});

test("programmatic return leaves a newer native selection from React intact", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  fixture.selectNativeButton("claude-code");
  adapter.restoreNative();

  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.ok(fixture.claudeCodeButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.claudeCodeButton.getAttribute("aria-current"), "page");
  adapter.stop();
});

test("native click waits for React selection instead of restoring the old native row", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});

  fixture.click(fixture.claudeCodeButton);
  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  fixture.selectNativeButton("claude-code");
  fixture.flushMutation();

  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.ok(fixture.claudeCodeButton.className.includes("bg-fill-ghost-selected"));
  adapter.stop();
});

test("clicking the previously selected native row restores it when React keeps the same route", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  adapter.start();
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  adapter.showPanel("config", () => {});
  assert.ok(!fixture.generalButton.className.includes("bg-fill-ghost-selected"));

  fixture.click(fixture.generalButton);

  assert.equal(fixture.findPanel(), null);
  assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
  assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
  adapter.stop();
});

for (const replacement of ["navigation", "dialog"] as const) {
  test(`${replacement} replacement restores only the new native row`, () => {
    const fixture = settingsFixture();
    const adapter = createClaudeSettingsShellAdapter(fixture.environment);
    adapter.start();
    adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
    const oldGeneral = fixture.generalButton;
    adapter.showPanel("config", () => {});

    if (replacement === "navigation") fixture.remountSettingsNavigation();
    else fixture.remountSettingsShell();
    fixture.flushMutation();
    adapter.restoreNative();

    assert.ok(!oldGeneral.isConnected);
    assert.ok(!oldGeneral.className.includes("bg-fill-ghost-selected"));
    assert.ok(fixture.generalButton.className.includes("bg-fill-ghost-selected"));
    assert.equal(fixture.generalButton.getAttribute("aria-current"), "page");
    adapter.stop();
  });
}

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

test("recovers navigation remounted inside the same visible dialog without a visibility transition", () => {
  const fixture = settingsFixture();
  const adapter = createClaudeSettingsShellAdapter(fixture.environment);
  const mounts: boolean[] = [];
  const states: boolean[] = [];
  adapter.setNavigationMountListener((visible) => mounts.push(visible));
  adapter.start();
  adapter.setVisibilityListener((visible) => states.push(visible));
  adapter.setNavigation([group("CLAUDE++", [{ id: "config", title: "Config" }])], () => {});
  assert.deepEqual(mounts, [true]);
  assert.deepEqual(states, [true]);

  fixture.remountSettingsNavigation();
  fixture.flushMutation();

  assert.equal(fixture.countButtons("config"), 1);
  assert.deepEqual(mounts, [true, true]);
  assert.deepEqual(states, [true]);
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
