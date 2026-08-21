import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClaudeInstall } from "../src/platform.ts";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";
import {
  assertManagedMirrorPath,
  ensureWindowsStoreMirror,
  type MirrorFileSystem,
} from "../src/windows-store-mirror.ts";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "claudepp-mirror-"));
  const source = join(root, "official", "app");
  mkdirSync(join(source, "resources"), { recursive: true });
  writeFileSync(join(source, "claude.exe"), "official-exe");
  writeFileSync(join(source, "resources", "app.asar"), "official-asar");
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: join(root, "roaming"),
    LOCALAPPDATA: join(root, "local"),
    USERPROFILE: join(root, "home"),
  });
  const install: ClaudeInstall = {
    packageFullName: "Claude_fixture_x64__test",
    packageVersion: "1.0.0.0",
    installLocation: join(root, "official"),
    appRoot: source,
    executablePath: join(source, "claude.exe"),
    resourcesPath: join(source, "resources"),
    asarPath: join(source, "resources", "app.asar"),
  };
  return { root, source, paths, install };
}

test("creates an idempotent managed mirror without writing the official app", async () => {
  const fixture = createFixture();
  try {
    const first = await ensureWindowsStoreMirror(fixture.install, fixture.paths);
    writeFileSync(join(first.appRoot, "managed-only.txt"), "keep");
    writeFileSync(join(fixture.source, "late-official.txt"), "late");

    const second = await ensureWindowsStoreMirror(fixture.install, fixture.paths);

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(readFileSync(join(second.appRoot, "managed-only.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(second.appRoot, "late-official.txt")), false);
    assert.equal(readFileSync(join(fixture.source, "claude.exe"), "utf8"), "official-exe");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("force refresh replaces a current marked mirror from the official source", async () => {
  const fixture = createFixture();
  try {
    const first = await ensureWindowsStoreMirror(fixture.install, fixture.paths);
    writeFileSync(join(first.appRoot, "managed-only.txt"), "remove");
    writeFileSync(join(fixture.source, "official-new.txt"), "copy");

    const second = await ensureWindowsStoreMirror(
      fixture.install,
      fixture.paths,
      { forceRefresh: true },
    );

    assert.equal(second.reused, false);
    assert.equal(existsSync(join(second.appRoot, "managed-only.txt")), false);
    assert.equal(readFileSync(join(second.appRoot, "official-new.txt"), "utf8"), "copy");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed force refresh restores the current mirror", async () => {
  const fixture = createFixture();
  try {
    const first = await ensureWindowsStoreMirror(fixture.install, fixture.paths);
    writeFileSync(join(first.appRoot, "sentinel.txt"), "old");
    writeFileSync(join(fixture.source, "sentinel.txt"), "new");
    const fileSystem: MirrorFileSystem = {
      forceRefresh: true,
      rename: async (source, target) => {
        if (source.includes(".staging-") && target === first.appRoot) {
          throw new Error("simulated force-refresh failure");
        }
        renameSync(source, target);
      },
    };

    await assert.rejects(
      ensureWindowsStoreMirror(fixture.install, fixture.paths, fileSystem),
      /simulated force-refresh failure/,
    );
    assert.equal(readFileSync(join(first.appRoot, "sentinel.txt"), "utf8"), "old");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a managed target outside the Claude++ store-apps root", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => assertManagedMirrorPath(join(fixture.root, "outside"), fixture.paths),
      /outside.*store-apps/i,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restores the stale mirror when replacement fails", async () => {
  const fixture = createFixture();
  try {
    const first = await ensureWindowsStoreMirror(fixture.install, fixture.paths);
    writeFileSync(join(first.appRoot, "sentinel.txt"), "old");
    fixture.install.packageVersion = "2.0.0.0";
    writeFileSync(join(fixture.source, "sentinel.txt"), "new");

    const realFs: MirrorFileSystem = {
      rename: async (source, target) => {
        if (source.includes(".staging-") && target === first.appRoot) {
          throw new Error("simulated replacement failure");
        }
        renameSync(source, target);
      },
    };

    await assert.rejects(
      ensureWindowsStoreMirror(fixture.install, fixture.paths, realFs),
      /simulated replacement failure/,
    );
    assert.equal(readFileSync(join(first.appRoot, "sentinel.txt"), "utf8"), "old");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
