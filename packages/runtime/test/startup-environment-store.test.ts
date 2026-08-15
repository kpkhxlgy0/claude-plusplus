import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { StartupEnvironmentConfig, TweakManifest } from "@claude-plusplus/sdk";
import {
  readStartupEnvironmentSnapshot,
  STARTUP_ENVIRONMENT_SNAPSHOT_VERSION,
  startupEnvironmentSnapshotPath,
  writeStartupEnvironmentSnapshot,
} from "../src/startup-environment-store.ts";

const manifest: TweakManifest = {
  id: "com.example.startup-env",
  name: "Startup env",
  version: "0.1.0",
  githubRepo: "example/startup-env",
  scope: "main",
  permissions: ["startup-environment"],
  startupEnvironment: { keys: ["EXAMPLE_MAX", "EXAMPLE_WINDOW"] },
};

const enabledConfig: StartupEnvironmentConfig = {
  enabled: true,
  variables: { EXAMPLE_MAX: "272000", EXAMPLE_WINDOW: "250000" },
};

test("returns no saved configuration when the snapshot is missing", () => {
  withRoot((root) => {
    assert.deepEqual(readStartupEnvironmentSnapshot(root, manifest), { config: null });
  });
});

test("round-trips one complete declared snapshot at the contained path", () => {
  withRoot((root) => {
    writeStartupEnvironmentSnapshot(root, manifest, enabledConfig);

    assert.equal(STARTUP_ENVIRONMENT_SNAPSHOT_VERSION, 1);
    assert.equal(
      startupEnvironmentSnapshotPath(root, manifest.id),
      join(root, "startup-environment", `${manifest.id}.json`),
    );
    assert.deepEqual(readStartupEnvironmentSnapshot(root, manifest), { config: enabledConfig });
    assert.equal(readFileSync(startupEnvironmentSnapshotPath(root, manifest.id), "utf8").endsWith("\n"), true);
  });
});

test("atomically replaces a snapshot without leaving staging files", () => {
  withRoot((root) => {
    writeStartupEnvironmentSnapshot(root, manifest, enabledConfig);
    const disabled = {
      enabled: false,
      variables: { EXAMPLE_MAX: "300000", EXAMPLE_WINDOW: "200000" },
    };

    writeStartupEnvironmentSnapshot(root, manifest, disabled);

    assert.deepEqual(readStartupEnvironmentSnapshot(root, manifest), { config: disabled });
    assert.deepEqual(readdirSync(dirname(startupEnvironmentSnapshotPath(root, manifest.id))), [
      `${manifest.id}.json`,
    ]);
  });
});

test("accepts unknown top-level fields for forward compatibility", () => {
  withRoot((root) => {
    writeRaw(root, {
      version: 1,
      enabled: true,
      variables: enabledConfig.variables,
      future: { mode: "later" },
    });

    assert.deepEqual(readStartupEnvironmentSnapshot(root, manifest), { config: enabledConfig });
  });
});

test("rejects malformed and unsupported snapshots without rewriting evidence", () => {
  for (const [name, contents, expected] of [
    ["malformed", "{not json", /valid JSON/i],
    ["unknown version", JSON.stringify({ version: 2, enabled: true, variables: enabledConfig.variables }), /version/i],
    ["non-object", JSON.stringify([]), /object/i],
    ["non-boolean enabled", JSON.stringify({ version: 1, enabled: "yes", variables: enabledConfig.variables }), /enabled/i],
  ] as const) {
    withRoot((root) => {
      const path = startupEnvironmentSnapshotPath(root, manifest.id);
      writeRawText(path, contents);

      const result = readStartupEnvironmentSnapshot(root, manifest);

      assert.equal(result.config, null, name);
      assert.match(result.error ?? "", expected, name);
      assert.equal(readFileSync(path, "utf8"), contents, name);
    });
  }
});

test("rejects partial, extra, and non-string variables without exposing values", () => {
  for (const [name, variables, expected] of [
    ["missing", { EXAMPLE_MAX: "secret-missing" }, /EXAMPLE_WINDOW/],
    ["extra", { ...enabledConfig.variables, EXTRA: "secret-extra" }, /EXTRA/],
    ["non-string", { EXAMPLE_MAX: "272000", EXAMPLE_WINDOW: 250000 }, /EXAMPLE_WINDOW/],
  ] as const) {
    withRoot((root) => {
      writeRaw(root, { version: 1, enabled: true, variables });

      const result = readStartupEnvironmentSnapshot(root, manifest);

      assert.equal(result.config, null, name);
      assert.match(result.error ?? "", expected, name);
      assert.doesNotMatch(result.error ?? "", /secret-/i, name);
    });
  }
});

test("refuses an incomplete write and preserves the prior snapshot", () => {
  withRoot((root) => {
    writeStartupEnvironmentSnapshot(root, manifest, enabledConfig);

    assert.throws(
      () => writeStartupEnvironmentSnapshot(root, manifest, {
        enabled: true,
        variables: { EXAMPLE_MAX: "300000" },
      }),
      /EXAMPLE_WINDOW/,
    );
    assert.deepEqual(readStartupEnvironmentSnapshot(root, manifest), { config: enabledConfig });
  });
});

test("rejects an unvalidated manifest id before constructing a path", () => {
  withRoot((root) => {
    assert.throws(
      () => startupEnvironmentSnapshotPath(root, "../escape"),
      /Tweak id/i,
    );
  });
});

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-startup-store-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeRaw(root: string, value: unknown): void {
  writeRawText(startupEnvironmentSnapshotPath(root, manifest.id), `${JSON.stringify(value, null, 2)}\n`);
}

function writeRawText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}
