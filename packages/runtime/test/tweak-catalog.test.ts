import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../src/config.ts";
import { listInstalledTweaks } from "../src/tweak-catalog.ts";

test("lists readable manifests even when disabled or missing an entry", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-catalog-"));
  try {
    writeTweak(root, "enabled", "com.example.enabled", true);
    writeTweak(root, "disabled", "com.example.disabled", true);
    writeTweak(root, "broken", "com.example.broken", false);

    const listed = listInstalledTweaks({
      tweaksRoot: root,
      config: configWithDisabled("com.example.disabled"),
    });

    assert.deepEqual(listed.map((item) => [
      item.manifest.id,
      item.enabled,
      item.entryExists,
    ]), [
      ["com.example.broken", true, false],
      ["com.example.disabled", false, true],
      ["com.example.enabled", true, true],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps an incompatible readable manifest visible with its compatibility issue", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-catalog-incompatible-"));
  try {
    writeTweak(root, "future", "com.example.future", true, "0.3.0");

    const [listed] = listInstalledTweaks({
      tweaksRoot: root,
      config: configWithDisabled(),
      runtimeVersion: "0.2.0",
    });

    assert.equal(listed?.compatible, false);
    assert.match(listed?.issue ?? "", /requires Claude\+\+ 0\.3\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeTweak(
  root: string,
  name: string,
  id: string,
  entry: boolean,
  minRuntime?: string,
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id,
    name: id,
    version: "0.2.0",
    githubRepo: "example/tweak",
    scope: "both",
    ...(minRuntime ? { minRuntime } : {}),
  }));
  if (entry) writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

function configWithDisabled(id?: string): RuntimeConfig {
  return {
    claudePlusPlus: {
      safeMode: false,
      autoUpdate: false,
      updateChannel: "stable",
      updateRepo: "kpkhxlgy0/claude-plusplus",
      updateRef: "",
    },
    tweaks: id ? { [id]: { enabled: false } } : {},
    tweakUpdateChecks: {},
  };
}
