import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";
import { cleanupWindowsManagedArtifacts } from "../src/windows-cleanup.ts";

test("managed Windows cleanup removes only the fixed store-apps root", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cleanup-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      USERPROFILE: join(root, "profile"),
    });
    const outside = join(root, "outside", "sentinel.txt");
    mkdirSync(join(paths.storeApps, "Claude_orphan", "app"), { recursive: true });
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "keep");

    assert.deepEqual(await cleanupWindowsManagedArtifacts(paths), []);
    assert.equal(existsSync(paths.storeApps), false);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed cleanup reports fixed-root guidance when removal is locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cleanup-locked-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      USERPROFILE: join(root, "profile"),
    });
    let removalCalls = 0;

    const warnings = await cleanupWindowsManagedArtifacts(paths, {
      rm: async (target, options) => {
        removalCalls += 1;
        assert.equal(target, paths.storeApps);
        assert.deepEqual(options, { recursive: true, force: true });
        throw Object.assign(new Error("locked managed mirror"), { code: "EBUSY" });
      },
    });

    assert.equal(removalCalls, 1);
    assert.deepEqual(warnings, [
      `Could not remove Claude++ managed Store mirrors at ${paths.storeApps}. ` +
      "Close Claude++ and rerun uninstall. locked managed mirror",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed cleanup rejects a substituted local child before removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cleanup-boundary-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      USERPROFILE: join(root, "profile"),
    });
    mkdirSync(paths.cache, { recursive: true });
    writeFileSync(join(paths.cache, "sentinel.txt"), "keep");
    await assert.rejects(
      cleanupWindowsManagedArtifacts({ ...paths, storeApps: paths.cache }),
      /exact Claude\+\+ store-apps root/i,
    );
    assert.equal(readFileSync(join(paths.cache, "sentinel.txt"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
