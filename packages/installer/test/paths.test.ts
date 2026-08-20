import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import {
  assertClaudePlusPlusLocalPath,
  assertClaudePlusPlusStoreAppsPath,
  resolveClaudePlusPlusPaths,
} from "../src/paths.ts";

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
