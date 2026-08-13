import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkClaudePlusPlusUpdate,
  getUpdateConfigView,
  runClaudePlusPlusUpdate,
} from "../src/update-service.ts";

test("returns the safe default update configuration with no prior result", () => {
  const fixture = updateServiceFixture();
  try {
    const view = getUpdateConfigView(fixture.paths);
    assert.equal(view.version, "0.2.0");
    assert.equal(view.autoUpdate, false);
    assert.equal(view.updateChannel, "stable");
    assert.equal(view.updateRepo, "kpkhxlgy0/claude-plusplus");
    assert.equal(view.updateCheck, null);
    assert.equal(view.selfUpdate, null);
  } finally {
    fixture.dispose();
  }
});

test("checks the selected release for display and persists the result", async () => {
  const fixture = updateServiceFixture();
  try {
    const result = await checkClaudePlusPlusUpdate({
      ...fixture.paths,
      requestReleases: async () => [{
        tag_name: "v0.3.0",
        html_url: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.0",
        body: "Release notes",
        draft: false,
        prerelease: false,
      }],
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    assert.equal(result.latestVersion, "0.3.0");
    assert.equal(result.updateAvailable, true);
    assert.equal(
      JSON.parse(readFileSync(fixture.paths.configFile, "utf8")).claudePlusPlus.updateCheck.latestVersion,
      "0.3.0",
    );
  } finally {
    fixture.dispose();
  }
});

test("does not treat an equal-core prerelease as newer than the installed release", async () => {
  const fixture = updateServiceFixture({ updateChannel: "prerelease" });
  try {
    const result = await checkClaudePlusPlusUpdate({
      ...fixture.paths,
      requestReleases: async () => [{
        tag_name: "v0.2.0-beta.1",
        draft: false,
        prerelease: true,
      }],
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    assert.equal(result.latestVersion, "0.2.0-beta.1");
    assert.equal(result.updateAvailable, false);
  } finally {
    fixture.dispose();
  }
});

test("Stable checks the official repository even when a saved Custom repository remains", async () => {
  const fixture = updateServiceFixture({ updateChannel: "stable", updateRepo: "example/custom" });
  try {
    let requestedRepo = "";
    await checkClaudePlusPlusUpdate({
      ...fixture.paths,
      requestReleases: async (repo) => {
        requestedRepo = repo;
        return [];
      },
      now: () => new Date("2026-08-13T00:00:00Z"),
    });
    assert.equal(requestedRepo, "kpkhxlgy0/claude-plusplus");
  } finally {
    fixture.dispose();
  }
});

test("starts the installed CLI with the configured channel instead of installing in Runtime", () => {
  const fixture = updateServiceFixture({ updateChannel: "prerelease" });
  try {
    const launches: Array<{ command: string; args: string[] }> = [];
    const result = runClaudePlusPlusUpdate({
      ...fixture.paths,
      launch: (command, args) => {
        launches.push({ command, args });
      },
    });

    assert.deepEqual(result, { status: "checking" });
    assert.equal(launches.length, 1);
    assert.match(launches[0].command, /node\.exe$/i);
    assert.deepEqual(launches[0].args.slice(-2), ["update", "--prerelease"]);
  } finally {
    fixture.dispose();
  }
});

function updateServiceFixture(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudepp-update-service-"));
  const sourceRoot = join(root, "source");
  const configFile = join(root, "config.json");
  const selfUpdateStateFile = join(root, "self-update.json");
  mkdirSync(join(sourceRoot, "toolchain"), { recursive: true });
  mkdirSync(join(sourceRoot, "packages", "installer", "dist"), { recursive: true });
  writeFileSync(join(sourceRoot, "toolchain", "node.exe"), "fixture");
  writeFileSync(join(sourceRoot, "packages", "installer", "dist", "cli.js"), "fixture");
  writeFileSync(configFile, JSON.stringify({ claudePlusPlus: config }));
  return {
    paths: { sourceRoot, configFile, selfUpdateStateFile },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
