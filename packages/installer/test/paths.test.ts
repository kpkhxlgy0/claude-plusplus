import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import {
  assertClaudePlusPlusLocalPath,
  assertClaudePlusPlusStoreAppsPath,
  resolveClaudePlusPlusPaths,
} from "../src/paths.ts";
import { writeClaudePlusPlusState } from "../src/state.ts";

test("resolves roaming, local, and source roots from Windows environment variables", () => {
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    USERPROFILE: "C:\\Users\\Test",
  });

  assert.equal(paths.roamingRoot, "C:\\Users\\Test\\AppData\\Roaming\\claude-plusplus");
  assert.equal(paths.localRoot, "C:\\Users\\Test\\AppData\\Local\\claude-plusplus");
  assert.equal(paths.sourceRoot, "C:\\Users\\Test\\.claude-plusplus\\source");
  assert.equal(paths.runtime, win32.join(paths.roamingRoot, "runtime"));
  assert.equal(paths.storeApps, win32.join(paths.localRoot, "store-apps"));
});

test("rejects a missing required Windows environment path", () => {
  assert.throws(
    () => resolveClaudePlusPlusPaths({ APPDATA: "C:\\Roaming" }),
    /LOCALAPPDATA/,
  );
});

test("resolves the installed source binding and retains the managed fallback for legacy state", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-path-binding-"));
  const env = { APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), USERPROFILE: join(root, "profile") };
  try {
    const initial = resolveClaudePlusPlusPaths(env);
    const state = {
      schemaVersion: 1 as const,
      claudePlusPlusVersion: "0.3.6", packageFullName: "fixture", packageVersion: "1",
      officialAppRoot: "official", managedAppRoot: "managed", managedExecutable: "managed/claude.exe",
      asarPath: "managed/app.asar", originalMain: "main.js", installedAt: "2026-10-28T00:00:00Z",
    };
    writeClaudePlusPlusState(initial.stateFile, { ...state, sourceRoot: join(root, "local source") });
    assert.equal(resolveClaudePlusPlusPaths(env).sourceRoot, join(root, "local source"));
    writeClaudePlusPlusState(initial.stateFile, state);
    assert.equal(resolveClaudePlusPlusPaths(env).sourceRoot, win32.join(env.USERPROFILE, ".claude-plusplus", "source"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local cleanup accepts store-apps and rejects siblings outside localRoot", () => {
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    USERPROFILE: "C:\\Users\\Test",
  });
  assert.doesNotThrow(() => assertClaudePlusPlusLocalPath(paths.storeApps, paths));
  assert.doesNotThrow(() => assertClaudePlusPlusStoreAppsPath(paths));
  assert.throws(
    () => assertClaudePlusPlusLocalPath("C:\\Users\\Test\\AppData\\Local\\outside", paths),
    /outside.*local root/i,
  );
  assert.throws(
    () => assertClaudePlusPlusStoreAppsPath({ ...paths, storeApps: paths.cache }),
    /exact Claude\+\+ store-apps root/i,
  );
});
