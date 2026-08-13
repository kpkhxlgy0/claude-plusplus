import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverTweaks } from "../src/tweak-discovery.ts";

test("discovers only valid Tweaks that can run in the requested process", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-discovery-"));
  try {
    writeTweak(root, "renderer", manifest("com.example.renderer", "renderer"));
    writeTweak(root, "main", manifest("com.example.main", "main"));
    writeTweak(root, "both", manifest("com.example.both", "both"));
    writeTweak(root, "omitted", manifest("com.example.omitted"));
    writeTweak(root, "invalid", { id: "missing-fields" });

    const rendererIds = discoverTweaks(root, "renderer").map((tweak) => tweak.manifest.id).sort();
    const mainIds = discoverTweaks(root, "main").map((tweak) => tweak.manifest.id).sort();

    assert.deepEqual(rendererIds, [
      "com.example.both",
      "com.example.omitted",
      "com.example.renderer",
    ]);
    assert.deepEqual(mainIds, [
      "com.example.both",
      "com.example.main",
      "com.example.omitted",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips malformed JSON and missing entry files without blocking valid Tweaks", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-discovery-errors-"));
  try {
    const malformed = join(root, "malformed");
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, "manifest.json"), "{not json");
    const missing = join(root, "missing-entry");
    mkdirSync(missing, { recursive: true });
    writeFileSync(join(missing, "manifest.json"), JSON.stringify({
      ...manifest("com.example.missing", "renderer"),
      main: "missing.js",
    }));
    writeTweak(root, "valid", manifest("com.example.valid", "renderer"));
    const issues: string[] = [];

    const discovered = discoverTweaks(root, "renderer", (message) => issues.push(message));

    assert.deepEqual(discovered.map((tweak) => tweak.manifest.id), ["com.example.valid"]);
    assert.equal(issues.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads only Tweaks compatible with the current Claude++ runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-discovery-version-"));
  try {
    writeTweak(root, "minimum-0-1", {
      ...manifest("com.example.minimum-0-1", "main"),
      minRuntime: "0.1.0",
    });
    writeTweak(root, "minimum-0-2", {
      ...manifest("com.example.minimum-0-2", "main"),
      minRuntime: "0.2.0",
    });
    writeTweak(root, "minimum-0-3", {
      ...manifest("com.example.minimum-0-3", "main"),
      minRuntime: "0.3.0",
    });
    const issues: string[] = [];

    const discovered = discoverTweaks(root, "main", (message) => issues.push(message), "0.2.0");

    assert.deepEqual(discovered.map((item) => item.manifest.id), [
      "com.example.minimum-0-1",
      "com.example.minimum-0-2",
    ]);
    assert.match(
      issues.join("\n"),
      /requires Claude\+\+ 0\.3\.0; current runtime is 0\.2\.0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeTweak(root: string, name: string, value: Record<string, unknown>): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(value));
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

function manifest(id: string, scope?: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "0.2.0",
    githubRepo: "example/tweak",
    ...(scope ? { scope } : {}),
  };
}
