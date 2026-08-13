import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  isTweakEnabled,
  readRuntimeConfig,
  setTweakEnabled,
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
