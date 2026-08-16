import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakLogger, TweakManifest } from "@claude-plusplus/sdk";
import {
  initializeClaudeCodeSettings,
  readSetting,
  removeSetting,
  resolveClaudeCodeSettingsFile,
  writeSetting,
} from "../src/claude-code-settings.ts";

const path = "skillOverrides.claude-api";
const log: TweakLogger = { debug() {}, info() {}, warn() {}, error() {} };

test("resolves the standard and CLAUDE_CONFIG_DIR settings files", () => {
  assert.equal(
    resolveClaudeCodeSettingsFile({}, "C:\\Users\\example"),
    join("C:\\Users\\example", ".claude", "settings.json"),
  );
  assert.equal(
    resolveClaudeCodeSettingsFile({ CLAUDE_CONFIG_DIR: "D:\\claude-profile" }, "ignored"),
    join("D:\\claude-profile", "settings.json"),
  );
});

test("reads a missing file and no-op removal does not create it", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-missing-"));
  try {
    const file = join(root, ".claude", "settings.json");
    const initial = readSetting(file, path);
    assert.deepEqual(initial, { exists: false, revision: "missing:v1" });
    assert.deepEqual(removeSetting(file, path, initial.revision), initial);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes and removes only the declared leaf while preserving unrelated settings", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-write-"));
  try {
    const file = join(root, "settings.json");
    writeFileSync(file, `${JSON.stringify({
      model: "opus[1m]",
      skillOverrides: { doctor: "name-only" },
      nested: { keep: [1, true, null] },
    }, null, 2)}\n`);
    const initial = readSetting(file, path);
    assert.equal(initial.exists, false);

    const written = writeSetting(file, path, "off", initial.revision);
    assert.deepEqual(written.value, "off");
    const afterWrite = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(afterWrite, {
      model: "opus[1m]",
      skillOverrides: { doctor: "name-only", "claude-api": "off" },
      nested: { keep: [1, true, null] },
    });

    const removed = removeSetting(file, path, written.revision);
    assert.equal(removed.exists, false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      model: "opus[1m]",
      skillOverrides: { doctor: "name-only" },
      nested: { keep: [1, true, null] },
    });
    assert.equal(readdirSync(root).some((name) => name.includes(".claude-plusplus-")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates a missing settings file atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-create-"));
  try {
    const file = join(root, ".claude", "settings.json");
    const written = writeSetting(file, path, "off", "missing:v1");
    assert.equal(written.exists, true);
    assert.equal(written.value, "off");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      skillOverrides: { "claude-api": "off" },
    });
    assert.equal(readdirSync(join(root, ".claude")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, non-object, and incompatible settings remain byte-for-byte unchanged", () => {
  for (const source of ["{bad json\n", "[]\n", '{"skillOverrides":"bad"}\n']) {
    const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-invalid-"));
    try {
      const file = join(root, "settings.json");
      writeFileSync(file, source);
      const action = () => {
        if (source.startsWith("{")) {
          const revision = source.includes("bad json")
            ? "irrelevant"
            : readSetting(file, "model").revision;
          writeSetting(file, path, "off", revision);
        } else {
          readSetting(file, path);
        }
      };
      assert.throws(action, /valid JSON|root must be|non-object/);
      assert.equal(readFileSync(file, "utf8"), source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects unsafe keys anywhere in existing settings without rewriting", () => {
  for (const source of [
    '{"__proto__":"bad","model":"opus"}\n',
    '{"nested":{"constructor":"bad"},"model":"opus"}\n',
  ]) {
    const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-unsafe-document-"));
    try {
      const file = join(root, "settings.json");
      writeFileSync(file, source);
      for (const action of [
        () => readSetting(file, path),
        () => writeSetting(file, path, "off", "missing:v1"),
        () => removeSetting(file, path, "missing:v1"),
      ]) {
        assert.throws(action, /unsafe object key/);
        assert.equal(readFileSync(file, "utf8"), source);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects ordinary and dangling settings symlinks without replacing them", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-symlink-"));
  try {
    const target = join(root, "target.json");
    const danglingTarget = join(root, "missing-target.json");
    writeFileSync(target, '{"model":"opus"}\n');

    for (const [name, linkTarget] of [
      ["ordinary.json", target],
      ["dangling.json", danglingTarget],
    ]) {
      const file = join(root, name);
      symlinkSync(linkTarget, file, "file");
      for (const action of [
        () => readSetting(file, path),
        () => writeSetting(file, path, "off", "missing:v1"),
        () => removeSetting(file, path, "missing:v1"),
      ]) {
        assert.throws(action, /must not be a symbolic link/);
        assert.equal(lstatSync(file).isSymbolicLink(), true);
      }
    }

    assert.equal(readFileSync(target, "utf8"), '{"model":"opus"}\n');
    assert.equal(existsSync(danglingTarget), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe JSON values and stale revisions without overwriting external edits", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-conflict-"));
  try {
    const file = join(root, "settings.json");
    writeFileSync(file, '{"model":"opus"}\n');
    const initial = readSetting(file, path);
    const unsafe = JSON.parse('{"__proto__":"bad"}') as never;
    assert.throws(() => writeSetting(file, path, unsafe, initial.revision), /unsafe object key/);
    assert.equal(readFileSync(file, "utf8"), '{"model":"opus"}\n');

    writeFileSync(file, '{"model":"sonnet"}\n');
    assert.throws(
      () => writeSetting(file, path, "off", initial.revision),
      /changed since they were read/,
    );
    assert.equal(readFileSync(file, "utf8"), '{"model":"sonnet"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe caller values produced by non-enumerable toJSON without rewriting", () => {
  const source = '{"model":"opus"}\n';
  for (const unsafeKey of ["__proto__", "constructor", "prototype"]) {
    const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-unsafe-to-json-"));
    try {
      const file = join(root, "settings.json");
      writeFileSync(file, source);
      const initial = readSetting(file, path);
      const unsafe = {};
      Object.defineProperty(unsafe, "toJSON", {
        value: () => JSON.parse(`{"${unsafeKey}":"bad"}`),
      });

      assert.throws(
        () => writeSetting(file, path, unsafe as never, initial.revision),
        /unsafe object key/,
      );
      assert.equal(readFileSync(file, "utf8"), source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("service enforces exact declared paths and revokes retained references", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-service-"));
  try {
    const service = initializeClaudeCodeSettings({
      settingsFile: join(root, "settings.json"),
      log,
    });
    const lease = service.createApiLease(manifest());
    const retained = lease.api;
    const initial = retained.read(path);
    assert.throws(() => retained.read("skillOverrides.doctor"), /not declared/);
    assert.throws(() => retained.read("skillOverrides"), /not declared/);
    assert.throws(() => retained.read("skillOverrides.claude-api.extra"), /not declared/);
    const written = retained.write(path, "off", initial.revision);
    assert.equal(written.value, "off");
    lease.dispose();
    assert.throws(() => retained.read(path), /disposed/);
    assert.throws(() => retained.write(path, "on", written.revision), /disposed/);
    assert.throws(() => retained.remove(path, written.revision), /disposed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service fails closed when permission, declaration, or Main scope is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-code-settings-manifest-"));
  try {
    const service = initializeClaudeCodeSettings({
      settingsFile: join(root, "settings.json"),
      log,
    });
    for (const [candidate, expected] of [
      [{ ...manifest(), permissions: [] }, /lacks claude-code-settings permission/],
      [{ ...manifest(), claudeCodeSettings: undefined }, /no Claude Code settings path declaration/],
      [{ ...manifest(), scope: "renderer" }, /cannot access Claude Code settings from Renderer scope/],
    ] as const) {
      assert.throws(() => service.createApiLease(candidate as TweakManifest), expected);
    }
    assert.equal(existsSync(join(root, "settings.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function manifest(): TweakManifest {
  return {
    id: "com.example.skill-override",
    name: "Skill override",
    version: "0.1.0",
    githubRepo: "example/skill-override",
    scope: "both",
    permissions: ["claude-code-settings"],
    claudeCodeSettings: { paths: [path] },
  };
}
