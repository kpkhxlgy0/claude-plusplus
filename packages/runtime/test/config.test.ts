import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  isTweakEnabled,
  mutateRuntimeConfigAdvisory,
  readRuntimeConfig,
  setTweakEnabled,
  type AdvisoryConfigIo,
  type ClaudePlusPlusUpdateCheck,
  type TweakUpdateCheck,
} from "../src/config.ts";

test("merges defaults without overwriting Safe Mode or unknown Tweak data", () => {
  withConfigFile({
    claudePlusPlus: { safeMode: true },
    tweaks: { "com.example.one": { enabled: false, custom: "keep" } },
    privateState: { keep: true },
  }, (file) => {
    const config = readRuntimeConfig(file);

    assert.equal(config.claudePlusPlus.safeMode, true);
    assert.equal(config.claudePlusPlus.autoUpdate, false);
    assert.equal(config.claudePlusPlus.updateChannel, "stable");
    assert.equal(config.claudePlusPlus.updateRepo, "kpkhxlgy0/claude-plusplus");
    assert.equal(config.claudePlusPlus.updateRef, "");
    assert.equal(config.tweaks["com.example.one"]?.enabled, false);
    assert.equal(config.tweaks["com.example.one"]?.custom, "keep");
    assert.deepEqual(config.privateState, { keep: true });
  });
});

test("missing Tweak enabled flags default to enabled and persist atomically", () => {
  withConfigFile({}, (file) => {
    assert.equal(isTweakEnabled(readRuntimeConfig(file), "com.example.one"), true);

    const updated = setTweakEnabled(file, "com.example.one", false);

    assert.equal(updated.tweaks["com.example.one"]?.enabled, false);
    assert.equal(readRuntimeConfig(file).tweaks["com.example.one"]?.enabled, false);
    assert.equal(
      readdirSync(dirname(file)).some((name) => name.includes(".staging-")),
      false,
    );
  });
});

test("malformed configuration falls back to defaults without rewriting evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-config-malformed-"));
  const file = join(root, "config.json");
  try {
    writeFileSync(file, "{broken", "utf8");

    const config = readRuntimeConfig(file);

    assert.equal(config.claudePlusPlus.safeMode, false);
    assert.equal(config.claudePlusPlus.autoUpdate, false);
    assert.equal(readFileSync(file, "utf8"), "{broken");
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory mutation refuses malformed and non-object config without replacing bytes", () => {
  for (const original of ["{broken", "[]\n", "null\n"]) {
    const root = mkdtempSync(join(tmpdir(), "claudepp-advisory-invalid-"));
    const file = join(root, "config.json");
    try {
      writeFileSync(file, original, "utf8");
      const result = mutateRuntimeConfigAdvisory(file, (config) => {
        config.claudePlusPlus.updateCheck = productCheck("0.3.1");
      });
      assert.equal(result.status, "refused-invalid");
      assert.equal(readFileSync(file, "utf8"), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("advisory mutation creates a missing config and normalizes a valid object", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-advisory-valid-"));
  const file = join(root, "config.json");
  try {
    const created = mutateRuntimeConfigAdvisory(file, (config) => {
      config.tweakUpdateChecks["com.example.one"] = tweakCheck("com.example.one", "0.1.0");
    });
    assert.equal(created.status, "persisted");

    writeFileSync(file, JSON.stringify({
      claudePlusPlus: { safeMode: "invalid", privateNested: { keep: true } },
      privateTop: { keep: true },
    }), "utf8");
    const normalized = mutateRuntimeConfigAdvisory(file, (config) => {
      config.claudePlusPlus.updateCheck = productCheck("0.3.1");
    });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(normalized.status, "persisted");
    assert.equal(stored.claudePlusPlus.safeMode, false);
    assert.deepEqual(stored.claudePlusPlus.privateNested, { keep: true });
    assert.deepEqual(stored.privateTop, { keep: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory mutation refuses unreadable input and contains write failure", () => {
  let writes = 0;
  const unreadable: AdvisoryConfigIo = {
    readText() {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    writeAtomic() {
      writes += 1;
    },
  };
  const refused = mutateRuntimeConfigAdvisory("config.json", () => {}, { io: unreadable });
  assert.equal(refused.status, "refused-invalid");
  assert.equal(writes, 0);

  const writeFailure: AdvisoryConfigIo = {
    readText: () => "{}",
    writeAtomic() {
      throw new Error("rename denied");
    },
  };
  const failed = mutateRuntimeConfigAdvisory("config.json", () => {}, { io: writeFailure });
  assert.deepEqual(failed, { status: "write-failed", error: "rename denied" });
});

function withConfigFile(
  value: Record<string, unknown>,
  run: (file: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-config-"));
  const file = join(root, "config.json");
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    run(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function productCheck(latestVersion: string): ClaudePlusPlusUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    currentVersion: "0.3.0",
    latestVersion,
    releaseUrl: `https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v${latestVersion}`,
    releaseNotes: null,
    updateAvailable: true,
  };
}

function tweakCheck(id: string, currentVersion: string): TweakUpdateCheck {
  return {
    checkedAt: "2026-08-22T00:00:00.000Z",
    repo: `example/${id}`,
    currentVersion,
    latestVersion: "0.2.0",
    latestTag: "v0.2.0",
    releaseUrl: `https://github.com/example/${id}/releases/tag/v0.2.0`,
    updateAvailable: true,
  };
}
