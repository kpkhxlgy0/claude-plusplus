import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig, TweakUpdateCheck } from "../src/config.ts";
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

test("attaches cached updates only to the matching manifest identity", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-catalog-identity-"));
  try {
    writeTweak(root, "enabled", "com.example.enabled", true);
    writeTweak(root, "broken", "com.example.broken", false);
    const config = configWithDisabled();
    config.tweakUpdateChecks["com.example.enabled"] = cachedTweakCheck({
      repo: "example/tweak",
      currentVersion: "0.2.0",
      latestVersion: "0.3.0",
    });
    config.tweakUpdateChecks["com.example.broken"] = cachedTweakCheck({
      repo: "example/old",
      currentVersion: "0.1.0",
      latestVersion: "9.9.9",
    });
    const listed = listInstalledTweaks({ tweaksRoot: root, config });
    const enabled = listed.find((item) => item.manifest.id === "com.example.enabled");
    const broken = listed.find((item) => item.manifest.id === "com.example.broken");
    assert.equal(enabled?.update?.latestVersion, "0.3.0");
    assert.equal(broken?.update, null);
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

function cachedTweakCheck(options: {
  repo: string;
  currentVersion: string;
  latestVersion: string;
}): TweakUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    repo: options.repo,
    currentVersion: options.currentVersion,
    latestVersion: options.latestVersion,
    latestTag: `v${options.latestVersion}`,
    releaseUrl: `https://github.com/${options.repo}/releases/tag/v${options.latestVersion}`,
    updateAvailable: true,
  };
}
