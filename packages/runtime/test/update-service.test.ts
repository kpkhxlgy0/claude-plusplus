import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkClaudePlusPlusUpdate,
  getUpdateConfigView,
  runClaudePlusPlusUpdate,
  type GitHubReleaseView,
  type ProductUpdateTimer,
} from "../src/update-service.ts";

test("returns the safe default update configuration with no prior result", () => {
  const fixture = updateServiceFixture();
  try {
    const view = getUpdateConfigView(fixture.paths);
    assert.equal(view.version, "0.3.0");
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
        tag_name: "v0.3.1",
        html_url: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.1",
        body: "Release notes",
        draft: false,
        prerelease: false,
      }],
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    assert.equal(result.latestVersion, "0.3.1");
    assert.equal(result.updateAvailable, true);
    assert.equal(
      JSON.parse(readFileSync(fixture.paths.configFile, "utf8")).claudePlusPlus.updateCheck.latestVersion,
      "0.3.1",
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
        tag_name: "v0.3.0-beta.1",
        draft: false,
        prerelease: true,
      }],
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    assert.equal(result.latestVersion, "0.3.0-beta.1");
    assert.equal(result.updateAvailable, false);
  } finally {
    fixture.dispose();
  }
});

test("product channels retain Claude++ repository and release-list selection", async () => {
  const cases = [
    {
      channel: "stable",
      savedRepo: "example/custom",
      expectedRepo: "kpkhxlgy0/claude-plusplus",
      expectedVersion: "0.3.1",
    },
    {
      channel: "prerelease",
      savedRepo: "example/custom",
      expectedRepo: "kpkhxlgy0/claude-plusplus",
      expectedVersion: "0.4.0-beta.1",
    },
    {
      channel: "custom",
      savedRepo: "example/custom",
      expectedRepo: "example/custom",
      expectedVersion: "0.3.1",
    },
  ] as const;

  for (const item of cases) {
    const fixture = updateServiceFixture({
      updateChannel: item.channel,
      updateRepo: item.savedRepo,
    });
    let requestedRepo = "";
    try {
      const result = await checkClaudePlusPlusUpdate({
        ...fixture.paths,
        force: true,
        requestReleases: async (repo) => {
          requestedRepo = repo;
          return [
            release("v0.4.0-beta.1", true),
            release("v0.3.1", false),
          ];
        },
      });
      assert.equal(requestedRepo, item.expectedRepo);
      assert.equal(result.latestVersion, item.expectedVersion);
    } finally {
      fixture.dispose();
    }
  }
});

test("the default product request uses the release-list endpoint", async () => {
  const fixture = updateServiceFixture({ updateChannel: "stable" });
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  const delays: number[] = [];
  globalThis.fetch = async () => {
    throw new Error("unexpected global fetch");
  };
  try {
    await checkClaudePlusPlusUpdate({
      ...fixture.paths,
      force: true,
      request: async (input) => {
        requestedUrl = String(input);
        return jsonResponse(200, [release("v0.3.1", false)]);
      },
      timer: recordingTestTimer(delays),
    });
    assert.equal(
      requestedUrl,
      "https://api.github.com/repos/kpkhxlgy0/claude-plusplus/releases?per_page=20",
    );
    assert.deepEqual(delays, [8_000]);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.dispose();
  }
});

test("automatic and forced product checks return results without replacing invalid config", async () => {
  for (const raw of ["{broken", "[]\n", "null\n"]) {
    for (const force of [false, true]) {
      const fixture = updateServiceFixtureRaw(raw);
      try {
        const result = await checkClaudePlusPlusUpdate({
          ...fixture.paths,
          force,
          requestReleases: async () => [release("v0.3.1", false)],
        });
        assert.equal(result.updateAvailable, true);
        assert.equal(readFileSync(fixture.paths.configFile, "utf8"), raw);
      } finally {
        fixture.dispose();
      }
    }
  }
});

test("overlapping product checks persist in completion order", async () => {
  const fixture = updateServiceFixture();
  const automaticReleases = deferred<GitHubReleaseView[]>();
  const forcedReleases = deferred<GitHubReleaseView[]>();
  try {
    const automatic = checkClaudePlusPlusUpdate({
      ...fixture.paths,
      requestReleases: async () => automaticReleases.promise,
      now: () => new Date("2026-08-13T00:00:00Z"),
    });
    const forced = checkClaudePlusPlusUpdate({
      ...fixture.paths,
      force: true,
      requestReleases: async () => forcedReleases.promise,
      now: () => new Date("2026-08-13T00:01:00Z"),
    });

    forcedReleases.resolve([release("v0.4.0", false)]);
    await forced;
    automaticReleases.resolve([release("v0.3.1", false)]);
    await automatic;

    assert.equal(
      JSON.parse(readFileSync(fixture.paths.configFile, "utf8")).claudePlusPlus.updateCheck.latestVersion,
      "0.3.1",
    );
  } finally {
    fixture.dispose();
  }
});

test("product checks report persistence issues without rejecting the result", async () => {
  const fixture = updateServiceFixture();
  const issues: string[] = [];
  try {
    const result = await checkClaudePlusPlusUpdate({
      ...fixture.paths,
      force: true,
      requestReleases: async () => [release("v0.3.1", false)],
      persist: () => ({ status: "write-failed", error: "denied" }),
      onIssue: (message) => issues.push(message),
    });

    assert.equal(result.latestVersion, "0.3.1");
    assert.deepEqual(issues, ["Claude++ update cache write-failed"]);
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
  return updateServiceFixtureRaw(JSON.stringify({ claudePlusPlus: config }));
}

function updateServiceFixtureRaw(raw: string) {
  const root = mkdtempSync(join(tmpdir(), "claudepp-update-service-"));
  const sourceRoot = join(root, "source");
  const configFile = join(root, "config.json");
  const selfUpdateStateFile = join(root, "self-update.json");
  mkdirSync(join(sourceRoot, "toolchain"), { recursive: true });
  mkdirSync(join(sourceRoot, "packages", "installer", "dist"), { recursive: true });
  writeFileSync(join(sourceRoot, "toolchain", "node.exe"), "fixture");
  writeFileSync(join(sourceRoot, "packages", "installer", "dist", "cli.js"), "fixture");
  writeFileSync(configFile, raw);
  return {
    paths: { sourceRoot, configFile, selfUpdateStateFile },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function release(tag: string, prerelease: boolean): GitHubReleaseView {
  return {
    tag_name: tag,
    html_url: `https://github.com/example/releases/tag/${tag}`,
    body: `${tag} release notes`,
    draft: false,
    prerelease,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingTestTimer(delays: number[]): ProductUpdateTimer {
  return {
    set(_callback, delay) {
      delays.push(delay);
      return {};
    },
    clear() {},
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
