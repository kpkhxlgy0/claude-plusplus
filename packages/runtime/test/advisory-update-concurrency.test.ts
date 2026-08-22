import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import {
  mutateRuntimeConfig,
  readRuntimeConfig,
} from "../src/config.ts";
import { createTweakUpdateChecker } from "../src/tweak-update.ts";
import {
  checkClaudePlusPlusUpdate,
  type GitHubReleaseView,
  type UpdateServicePaths,
} from "../src/update-service.ts";

test("parallel product and distinct-id Tweak completions preserve every slot and intervening config", async () => {
  const fixture = concurrencyFixture();
  const tweakGates = new Map<string, Deferred<Response>>();
  const checker = createTweakUpdateChecker({
    request: async (input) => {
      const id = repoFromUrl(String(input));
      const gate = deferred<Response>();
      tweakGates.set(id, gate);
      return await gate.promise;
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const productGate = deferred<GitHubReleaseView[]>();
  try {
    const checks = [
      checker.ensure({ configFile: fixture.configFile, manifest: manifestFor("one") }),
      checker.ensure({ configFile: fixture.configFile, manifest: manifestFor("two") }),
      checker.ensure({ configFile: fixture.configFile, manifest: manifestFor("three") }),
      checkClaudePlusPlusUpdate({
        ...fixture.updatePaths,
        force: true,
        now: () => new Date("2026-08-22T00:00:00.000Z"),
        requestReleases: async () => await productGate.promise,
      }),
    ];
    mutateRuntimeConfig(fixture.configFile, (config) => {
      config.privateState = { changedWhilePending: true };
    });

    const one = requireGate(tweakGates, "one");
    const two = requireGate(tweakGates, "two");
    const three = requireGate(tweakGates, "three");
    one.resolve(latestResponse("one", "0.2.0"));
    productGate.resolve([release("v0.3.1", false)]);
    three.resolve(latestResponse("three", "0.2.0"));
    two.resolve(latestResponse("two", "0.2.0"));
    await Promise.all(checks);

    const stored = readRuntimeConfig(fixture.configFile);
    assert.deepEqual(stored.privateState, { changedWhilePending: true });
    assert.equal(stored.claudePlusPlus.updateCheck?.latestVersion, "0.3.1");
    assert.deepEqual(Object.keys(stored.tweakUpdateChecks).sort(), [
      "com.example.one",
      "com.example.three",
      "com.example.two",
    ]);
  } finally {
    fixture.dispose();
  }
});

test("same-id different-identity completions retain one-slot last-completion behavior", async () => {
  const fixture = concurrencyFixture();
  const requests: Array<{ repo: string; gate: Deferred<Response> }> = [];
  const checker = createTweakUpdateChecker({
    request: async (input) => {
      const gate = deferred<Response>();
      requests.push({ repo: repoFromUrl(String(input)), gate });
      return await gate.promise;
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const oldManifest = manifestFor("shared", { repo: "example/old", version: "0.1.0" });
  const newManifest = manifestFor("shared", { repo: "example/new", version: "0.1.1" });
  try {
    const oldCheck = checker.ensure({ configFile: fixture.configFile, manifest: oldManifest });
    const newCheck = checker.ensure({ configFile: fixture.configFile, manifest: newManifest });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.repo), ["old", "new"]);
    const oldRequest = requests[0];
    const newRequest = requests[1];
    assert.ok(oldRequest);
    assert.ok(newRequest);

    newRequest.gate.resolve(latestResponse("new", "0.3.0"));
    const newResult = await newCheck;
    oldRequest.gate.resolve(latestResponse("old", "0.2.0"));
    const oldResult = await oldCheck;

    assert.deepEqual(
      [newResult.repo, newResult.currentVersion, newResult.latestVersion],
      ["example/new", "0.1.1", "0.3.0"],
    );
    assert.deepEqual(
      [oldResult.repo, oldResult.currentVersion, oldResult.latestVersion],
      ["example/old", "0.1.0", "0.2.0"],
    );
    const stored = readRuntimeConfig(fixture.configFile).tweakUpdateChecks["com.example.shared"];
    assert.deepEqual(
      [stored?.repo, stored?.currentVersion, stored?.latestVersion],
      ["example/old", "0.1.0", "0.2.0"],
    );

    const refreshedNew = checker.ensure({ configFile: fixture.configFile, manifest: newManifest });
    assert.equal(requests.length, 3);
    const thirdRequest = requests[2];
    assert.ok(thirdRequest);
    assert.equal(thirdRequest.repo, "new");
    thirdRequest.gate.resolve(latestResponse("new", "0.3.0"));
    assert.equal((await refreshedNew).latestVersion, "0.3.0");
  } finally {
    fixture.dispose();
  }
});

function concurrencyFixture(): {
  configFile: string;
  updatePaths: UpdateServicePaths;
  dispose(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "claudepp-advisory-concurrency-"));
  const sourceRoot = join(root, "source");
  const configFile = join(root, "config.json");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(configFile, "{}\n", "utf8");
  return {
    configFile,
    updatePaths: {
      sourceRoot,
      configFile,
      selfUpdateStateFile: join(root, "self-update.json"),
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function repoFromUrl(url: string): string {
  const match = /\/repos\/[^/]+\/([^/]+)\/releases\/latest$/.exec(url);
  assert.ok(match?.[1], `unexpected release URL: ${url}`);
  return match[1];
}

function latestResponse(repo: string, version: string): Response {
  return new Response(JSON.stringify({
    tag_name: `v${version}`,
    html_url: `https://github.com/example/${repo}/releases/tag/v${version}`,
    draft: false,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function manifestFor(
  suffix: string,
  options: { repo?: string; version?: string } = {},
): TweakManifest {
  return {
    id: `com.example.${suffix}`,
    name: `Example ${suffix}`,
    version: options.version ?? "0.1.0",
    githubRepo: options.repo ?? `example/${suffix}`,
    scope: "renderer",
  };
}

function release(tag: string, prerelease: boolean): GitHubReleaseView {
  return {
    tag_name: tag,
    html_url: `https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/${tag}`,
    body: "Fixture release notes",
    draft: false,
    prerelease,
  };
}

function requireGate(gates: Map<string, Deferred<Response>>, id: string): Deferred<Response> {
  const gate = gates.get(id);
  assert.ok(gate, `missing deferred request gate: ${id}`);
  return gate;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
