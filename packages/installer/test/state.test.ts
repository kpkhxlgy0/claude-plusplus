import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isClaudePlusPlusStateV2,
  readClaudePlusPlusState,
} from "../src/state.ts";

const base = {
  claudePlusPlusVersion: "0.2.9",
  packageFullName: "Claude_fixture_x64__test",
  packageVersion: "1.0.0.0",
  officialAppRoot: "C:\\official\\app",
  managedAppRoot: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app",
  managedExecutable: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app\\claude.exe",
  asarPath: "C:\\local\\claude-plusplus\\store-apps\\Claude_fixture\\app\\resources\\app.asar",
  originalMain: ".vite/build/index.pre.js",
  installedAt: "2026-08-20T00:00:00.000Z",
  watcher: "scheduled-task" as const,
};

const schema1Fixture = { schemaVersion: 1 as const, ...base };
const schema2Fixture = {
  schemaVersion: 2 as const,
  ...base,
  originalAsarHash: "1".repeat(64),
  patchedAsarHash: "a".repeat(64),
};

test("state reader accepts schema 1 and strict schema 2 hashes", () => {
  withStateFile(schema1Fixture, (file) => {
    const state = readClaudePlusPlusState(file);
    assert.deepEqual(state, schema1Fixture);
    assert.equal(isClaudePlusPlusStateV2(state), false);
  });
  withStateFile(schema2Fixture, (file) => {
    const state = readClaudePlusPlusState(file);
    assert.deepEqual(state, schema2Fixture);
    assert.equal(isClaudePlusPlusStateV2(state), true);
  });
});

test("state reader rejects malformed schema 2 hashes", () => {
  withStateFile({
    schemaVersion: 2,
    ...base,
    originalAsarHash: "ABC",
    patchedAsarHash: "a".repeat(64),
  }, (file) => assert.equal(readClaudePlusPlusState(file), null));
});

for (const field of ["originalAsarHash", "patchedAsarHash"] as const) {
  for (const invalid of [
    undefined,
    7,
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
  ]) {
    test(`state reader rejects ${field} value ${String(invalid)}`, () => {
      const value: Record<string, unknown> = {
        schemaVersion: 2,
        ...base,
        originalAsarHash: "1".repeat(64),
        patchedAsarHash: "a".repeat(64),
      };
      if (invalid === undefined) delete value[field];
      else value[field] = invalid;
      withStateFile(value, (file) => assert.equal(readClaudePlusPlusState(file), null));
    });
  }
}

for (const fixture of [
  { name: "schema 1", value: schema1Fixture },
  { name: "schema 2", value: schema2Fixture },
] as const) {
  for (const field of [
    "claudePlusPlusVersion",
    "packageFullName",
    "packageVersion",
    "officialAppRoot",
    "managedAppRoot",
    "managedExecutable",
    "asarPath",
    "originalMain",
    "installedAt",
  ] as const) {
    test(`state reader rejects ${fixture.name} missing common field ${field}`, () => {
      const value: Record<string, unknown> = { ...fixture.value };
      delete value[field];
      withStateFile(value, (file) => assert.equal(readClaudePlusPlusState(file), null));
    });

    test(`state reader rejects ${fixture.name} non-string common field ${field}`, () => {
      const value: Record<string, unknown> = { ...fixture.value, [field]: 7 };
      withStateFile(value, (file) => assert.equal(readClaudePlusPlusState(file), null));
    });
  }
}

test("state reader rejects unsupported schemas and normalizes Watcher", () => {
  withStateFile({ schemaVersion: 3, ...base }, (file) => {
    assert.equal(readClaudePlusPlusState(file), null);
  });
  withStateFile({ schemaVersion: 1, ...base, watcher: "unexpected" }, (file) => {
    assert.equal(readClaudePlusPlusState(file)?.watcher, "none");
  });
  const { watcher: _watcher, ...withoutWatcher } = base;
  withStateFile({ schemaVersion: 1, ...withoutWatcher }, (file) => {
    assert.equal(readClaudePlusPlusState(file)?.watcher, "none");
  });
});

function withStateFile(
  value: unknown,
  assertion: (file: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-state-"));
  try {
    const file = join(root, "state.json");
    writeFileSync(file, JSON.stringify(value), "utf8");
    assertion(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
