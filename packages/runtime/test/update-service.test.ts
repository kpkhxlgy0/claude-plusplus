import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(view.version, "0.3.2");
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
        tag_name: "v0.3.3",
        html_url: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.3",
        body: "Release notes",
        draft: false,
        prerelease: false,
      }],
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    assert.equal(result.latestVersion, "0.3.3");
    assert.equal(result.updateAvailable, true);
    assert.equal(
      JSON.parse(readFileSync(fixture.paths.configFile, "utf8")).claudePlusPlus.updateCheck.latestVersion,
      "0.3.3",
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
        tag_name: "v0.3.2-beta.1",
        draft: false,
        prerelease: true,
      }],
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    assert.equal(result.latestVersion, "0.3.2-beta.1");
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
          requestReleases: async () => [release("v0.3.3", false)],
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

test("starts the installed CLI with the configured channel instead of installing in Runtime", async () => {
  const fixture = updateServiceFixture({ updateChannel: "prerelease" });
  try {
    const launches: Array<{ command: string; args: string[] }> = [];
    const result = await runClaudePlusPlusUpdate({
      ...fixture.paths,
      probeNodeVersion: () => {
        throw new Error("bundled Node.js must not use the source-runtime probe");
      },
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

test("source installs start the updater with their recorded Node.js 24+ runtime", async () => {
  const fixture = updateServiceFixture();
  const nodeRuntimePath = join(fixture.root, "system-node", "node.exe");
  try {
    mkdirSync(join(fixture.root, "system-node"), { recursive: true });
    writeFileSync(nodeRuntimePath, "fixture");
    rmSync(join(fixture.paths.sourceRoot, "toolchain", "node.exe"));
    writeFileSync(
      fixture.paths.stateFile,
      JSON.stringify({ schemaVersion: 2, nodeRuntimePath }),
    );
    const launches: Array<{ command: string; args: string[] }> = [];

    const result = await runClaudePlusPlusUpdate({
      ...fixture.paths,
      probeNodeVersion: (path) => {
        assert.equal(path, nodeRuntimePath);
        return "v26.7.0";
      },
      launch: (command, args) => launches.push({ command, args }),
    });

    assert.deepEqual(result, { status: "checking" });
    assert.equal(launches[0]?.command, nodeRuntimePath);
    assert.deepEqual(launches[0]?.args.slice(-1), ["update"]);
  } finally {
    fixture.dispose();
  }
});

test("source installs reject a recorded Node.js runtime older than 24 before starting an update", async () => {
  const fixture = updateServiceFixture();
  const nodeRuntimePath = join(fixture.root, "system-node", "node.exe");
  try {
    mkdirSync(join(fixture.root, "system-node"), { recursive: true });
    writeFileSync(nodeRuntimePath, "fixture");
    rmSync(join(fixture.paths.sourceRoot, "toolchain", "node.exe"));
    writeFileSync(
      fixture.paths.stateFile,
      JSON.stringify({ schemaVersion: 2, nodeRuntimePath }),
    );
    let launched = false;

    await assert.rejects(
      runClaudePlusPlusUpdate({
        ...fixture.paths,
        probeNodeVersion: () => "v23.11.1",
        launch: () => { launched = true; },
      }),
      /Node\.js 24 or newer/i,
    );
    assert.equal(launched, false);
    assert.equal(existsSync(fixture.paths.selfUpdateStateFile), false);
  } finally {
    fixture.dispose();
  }
});

test("source installs without a recorded Node.js runtime fail before writing checking state", async () => {
  const fixture = updateServiceFixture();
  try {
    rmSync(join(fixture.paths.sourceRoot, "toolchain", "node.exe"));
    let launched = false;

    await assert.rejects(
      runClaudePlusPlusUpdate({
        ...fixture.paths,
        launch: () => { launched = true; },
      }),
      /Node\.js 24 or newer.*Re-run install\.ps1/is,
    );
    assert.equal(launched, false);
    assert.equal(existsSync(fixture.paths.selfUpdateStateFile), false);
  } finally {
    fixture.dispose();
  }
});

test("does not launch another updater while a self-update is already checking", async () => {
  const fixture = updateServiceFixture();
  try {
    writeFileSync(fixture.paths.selfUpdateStateFile, JSON.stringify({
      checkedAt: new Date().toISOString(),
      status: "checking",
      currentVersion: "0.3.2",
      latestVersion: null,
      targetRef: null,
      releaseUrl: null,
      repo: "kpkhxlgy0/claude-plusplus",
      channel: "stable",
      sourceRoot: fixture.paths.sourceRoot,
      sourceLabel: "Packaged Windows release",
      processId: process.pid,
    }));
    let launches = 0;

    const result = await runClaudePlusPlusUpdate({
      ...fixture.paths,
      launch: () => { launches += 1; },
    });

    assert.deepEqual(result, { status: "checking" });
    assert.equal(launches, 0);
  } finally {
    fixture.dispose();
  }
});

test("an abandoned checking state does not permanently block a new updater", async () => {
  const fixture = updateServiceFixture();
  try {
    writeFileSync(fixture.paths.selfUpdateStateFile, JSON.stringify({
      checkedAt: "2000-01-01T00:00:00.000Z",
      status: "checking",
      currentVersion: "0.3.2",
      latestVersion: null,
      targetRef: null,
      releaseUrl: null,
      repo: "kpkhxlgy0/claude-plusplus",
      channel: "stable",
      sourceRoot: fixture.paths.sourceRoot,
      sourceLabel: "Packaged Windows release",
    }));
    let launches = 0;

    const result = await runClaudePlusPlusUpdate({
      ...fixture.paths,
      launch: () => { launches += 1; },
    });

    assert.deepEqual(result, { status: "checking" });
    assert.equal(launches, 1);
  } finally {
    fixture.dispose();
  }
});

test("config view presents an abandoned checking state as retryable failure", () => {
  const fixture = updateServiceFixture();
  try {
    writeFileSync(fixture.paths.selfUpdateStateFile, JSON.stringify({
      checkedAt: "2000-01-01T00:00:00.000Z",
      status: "checking",
      currentVersion: "0.3.2",
      latestVersion: null,
      targetRef: null,
      releaseUrl: null,
      repo: "kpkhxlgy0/claude-plusplus",
      channel: "stable",
      sourceRoot: fixture.paths.sourceRoot,
      sourceLabel: "Packaged Windows release",
    }));

    const view = getUpdateConfigView(fixture.paths);

    assert.equal(view.selfUpdate?.status, "failed");
    assert.match(view.selfUpdate?.error ?? "", /did not complete.*retry/i);
  } finally {
    fixture.dispose();
  }
});

test("records the spawned updater process id while launch state is still current", async () => {
  const fixture = updateServiceFixture();
  try {
    await runClaudePlusPlusUpdate({
      ...fixture.paths,
      launch: () => 4242,
    });

    const state = JSON.parse(readFileSync(fixture.paths.selfUpdateStateFile, "utf8"));
    assert.equal(state.status, "checking");
    assert.equal(state.processId, 4242);
  } finally {
    fixture.dispose();
  }
});

test("records a failed state and rejects when updater launch fails asynchronously", async () => {
  const fixture = updateServiceFixture();
  try {
    const launchFailure = Promise.reject(new Error("spawn EACCES"));
    void launchFailure.catch(() => {});

    await assert.rejects(
      runClaudePlusPlusUpdate({
        ...fixture.paths,
        launch: () => launchFailure,
      }),
      /Could not start Claude\+\+ updater.*spawn EACCES/i,
    );
    const state = JSON.parse(readFileSync(fixture.paths.selfUpdateStateFile, "utf8"));
    assert.equal(state.status, "failed");
    assert.match(state.error, /spawn EACCES/i);
    assert.equal(typeof state.completedAt, "string");
  } finally {
    fixture.dispose();
  }
});

test("default detached launch converts process-creation errors into failed state", async () => {
  const fixture = updateServiceFixture();
  try {
    await assert.rejects(
      runClaudePlusPlusUpdate(fixture.paths),
      /Could not start Claude\+\+ updater/i,
    );
    const state = JSON.parse(readFileSync(fixture.paths.selfUpdateStateFile, "utf8"));
    assert.equal(state.status, "failed");
    assert.match(state.error, /Could not start Claude\+\+ updater/i);
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
  const stateFile = join(root, "state.json");
  const selfUpdateStateFile = join(root, "self-update.json");
  mkdirSync(join(sourceRoot, "toolchain"), { recursive: true });
  mkdirSync(join(sourceRoot, "packages", "installer", "dist"), { recursive: true });
  writeFileSync(join(sourceRoot, "toolchain", "node.exe"), "fixture");
  writeFileSync(join(sourceRoot, "packages", "installer", "dist", "cli.js"), "fixture");
  writeFileSync(configFile, raw);
  return {
    root,
    paths: { sourceRoot, configFile, stateFile, selfUpdateStateFile },
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
