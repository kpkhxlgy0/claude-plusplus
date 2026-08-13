import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as asar from "@electron/asar";
import { injectClaudePlusPlusLoader, inspectClaudePlusPlusLoader } from "../src/asar.ts";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";

test("injects Claude++ metadata and preserves the original main across reinjection", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-asar-"));
  try {
    const source = join(root, "source");
    const local = join(root, "local");
    const managedAppRoot = join(local, "claude-plusplus", "store-apps", "Claude_fixture", "app");
    const asarPath = join(managedAppRoot, "resources", "app.asar");
    mkdirSync(source, { recursive: true });
    mkdirSync(dirname(asarPath), { recursive: true });
    writeFileSync(
      join(source, "package.json"),
      `${JSON.stringify({ name: "fixture-claude", main: ".vite/build/index.pre.js" }, null, 2)}\n`,
    );
    mkdirSync(join(source, ".vite", "build"), { recursive: true });
    writeFileSync(join(source, ".vite", "build", "index.pre.js"), "module.exports = 'original';\n");
    await asar.createPackage(source, asarPath);
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: local,
      USERPROFILE: join(root, "home"),
    });
    const loaderPath = resolve("packages", "loader", "loader.cjs");

    const first = await injectClaudePlusPlusLoader({
      managedAppRoot,
      asarPath,
      loaderPath,
      userRoot: "C:\\Users\\Test\\AppData\\Roaming\\claude-plusplus",
      loaderVersion: "0.2.0",
    }, paths);
    const second = await injectClaudePlusPlusLoader({
      managedAppRoot,
      asarPath,
      loaderPath,
      userRoot: "C:\\Users\\Test\\AppData\\Roaming\\claude-plusplus",
      loaderVersion: "0.2.0",
    }, paths);
    const extractedPackage = JSON.parse(
      asar.extractFile(asarPath, "package.json").toString("utf8"),
    );

    assert.equal(first.originalMain, ".vite/build/index.pre.js");
    assert.equal(second.originalMain, ".vite/build/index.pre.js");
    assert.equal(extractedPackage.main, "claude-plusplus-loader.cjs");
    assert.deepEqual(extractedPackage.__claudepp, {
      originalMain: ".vite/build/index.pre.js",
      userRoot: "C:\\Users\\Test\\AppData\\Roaming\\claude-plusplus",
      loaderVersion: "0.2.0",
    });
    assert.equal(
      asar.extractFile(asarPath, "claude-plusplus-loader.cjs").toString("utf8"),
      readFileSync(loaderPath, "utf8"),
    );
    assert.deepEqual(inspectClaudePlusPlusLoader(asarPath), second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to inject an ASAR outside the managed mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-asar-boundary-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      USERPROFILE: join(root, "home"),
    });
    await assert.rejects(
      injectClaudePlusPlusLoader({
        managedAppRoot: join(root, "official", "app"),
        asarPath: join(root, "official", "app", "resources", "app.asar"),
        loaderPath: resolve("packages", "loader", "loader.cjs"),
        userRoot: paths.roamingRoot,
        loaderVersion: "0.2.0",
      }, paths),
      /outside.*store-apps/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
