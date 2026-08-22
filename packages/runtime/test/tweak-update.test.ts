import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import {
  checkTweakRelease,
  createTweakUpdateChecker,
  type ReleaseTimer,
  type ReleaseTimerHandle,
  TWEAK_UPDATE_INTERVAL_MS,
} from "../src/tweak-update.ts";

test("reports a newer release but never installs it", async () => {
  const result = await checkTweakRelease(
    { manifest: manifest("0.1.0") },
    async () => jsonResponse(200, {
      tag_name: "v0.2.0",
      html_url: "https://github.com/example/tweak/releases/tag/v0.2.0",
    }),
    new Date("2026-08-13T10:00:00.000Z"),
  );

  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, "0.2.0");
  assert.equal(result.releaseUrl, "https://github.com/example/tweak/releases/tag/v0.2.0");
});

test("an inaccessible repository records an error without rejecting", async () => {
  const result = await checkTweakRelease(
    { manifest: manifest("0.1.0") },
    async () => jsonResponse(404, {}),
  );

  assert.equal(result.updateAvailable, false);
  assert.match(result.error ?? "", /release found/i);
});

test("a non-OK release response records the status without rejecting", async () => {
  const result = await checkTweakRelease(
    { manifest: manifest("0.1.0") },
    async () => jsonResponse(503, {}),
  );

  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, "GitHub returned 503");
});

test("a rejected release request records the error without rejecting", async () => {
  const result = await checkTweakRelease(
    { manifest: manifest("0.1.0") },
    async () => {
      throw new Error("fixture network denied");
    },
  );

  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, "fixture network denied");
});

test("same identity shares only the in-flight request", async () => {
  const fixture = updateFixture("{broken");
  const gate = deferred<Response>();
  let requests = 0;
  const checker = createTweakUpdateChecker({
    request: async () => {
      requests += 1;
      return await gate.promise;
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });

  const first = checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  const second = checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  assert.equal(requests, 1);
  assert.strictEqual(first, second);
  gate.resolve(jsonResponse(200, { tag_name: "v0.2.0" }));
  assert.deepEqual(await first, await second);

  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  assert.equal(requests, 2);
  assert.equal(readFileSync(fixture.configFile, "utf8"), "{broken");
  fixture.dispose();
});

test("cache expires exactly at twenty-four hours and identity changes do not join", async () => {
  const fixture = updateFixture("{}\n");
  let requests = 0;
  let current = new Date("2026-08-22T00:00:00.000Z");
  const checker = createTweakUpdateChecker({
    request: async () => {
      requests += 1;
      return jsonResponse(200, { tag_name: "v0.2.0" });
    },
    now: () => current,
  });

  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  current = new Date(current.getTime() + TWEAK_UPDATE_INTERVAL_MS - 1);
  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  assert.equal(requests, 1);

  current = new Date("2026-08-23T00:00:00.000Z");
  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.0") });
  await checker.ensure({ configFile: fixture.configFile, manifest: manifest("0.1.1") });
  await checker.ensure({
    configFile: fixture.configFile,
    manifest: { ...manifest("0.1.1"), githubRepo: "example/other" },
  });
  assert.equal(requests, 4);
  fixture.dispose();
});

test("different identities never share overlapping release requests", async () => {
  const fixture = updateFixture("{}\n");
  const firstGate = deferred<Response>();
  const secondGate = deferred<Response>();
  let requests = 0;
  const checker = createTweakUpdateChecker({
    request: async () => {
      requests += 1;
      return await (requests === 1 ? firstGate.promise : secondGate.promise);
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const firstManifest = manifest("0.1.0");
  const secondManifest = {
    ...manifest("0.1.1"),
    githubRepo: "example/other",
  };

  const first = checker.ensure({ configFile: fixture.configFile, manifest: firstManifest });
  const second = checker.ensure({ configFile: fixture.configFile, manifest: secondManifest });
  assert.equal(requests, 2);
  assert.notStrictEqual(first, second);

  secondGate.resolve(jsonResponse(200, {
    tag_name: "v0.3.0",
    html_url: "https://github.com/example/other/releases/tag/v0.3.0",
  }));
  firstGate.resolve(jsonResponse(200, {
    tag_name: "v0.2.0",
    html_url: "https://github.com/example/tweak/releases/tag/v0.2.0",
  }));

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(
    [firstResult.repo, firstResult.currentVersion, firstResult.latestVersion],
    ["example/tweak", "0.1.0", "0.2.0"],
  );
  assert.deepEqual(
    [secondResult.repo, secondResult.currentVersion, secondResult.latestVersion],
    ["example/other", "0.1.1", "0.3.0"],
  );
  fixture.dispose();
});

test("the injected eight-second timer aborts without wall-clock waiting", async () => {
  const fixture = updateFixture(null);
  const scheduled: { value?: { delay: number; callback: () => void } } = {};
  let unrefCalled = false;
  let cleared: ReleaseTimerHandle | undefined;
  const handle: ReleaseTimerHandle = {
    unref() {
      unrefCalled = true;
    },
  };
  const timer: ReleaseTimer = {
    set(callback, delay) {
      scheduled.value = { callback, delay };
      return handle;
    },
    clear(actual) {
      cleared = actual;
    },
  };
  const checker = createTweakUpdateChecker({
    timer,
    request: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted by fixture")),
        { once: true },
      );
    }),
  });
  const pending = checker.ensure({
    configFile: fixture.configFile,
    manifest: manifest("0.1.0"),
  });
  assert.equal(scheduled.value?.delay, 8_000);
  assert.equal(unrefCalled, true);
  scheduled.value?.callback();
  const result = await pending;
  assert.equal(result.updateAvailable, false);
  assert.match(result.error ?? "", /aborted by fixture/);
  assert.strictEqual(cleared, handle);
  fixture.dispose();
});

test("non-object config returns a fresh check without replacing config bytes", async (t) => {
  for (const original of ["[]\n", "null\n"]) {
    await t.test(JSON.stringify(original.trim()), async () => {
      const fixture = updateFixture(original);
      const checker = createTweakUpdateChecker({
        request: async () => jsonResponse(200, { tag_name: "v0.2.0" }),
        now: () => new Date("2026-08-22T00:00:00.000Z"),
      });

      const result = await checker.ensure({
        configFile: fixture.configFile,
        manifest: manifest("0.1.0"),
      });

      assert.equal(result.latestVersion, "0.2.0");
      assert.equal(result.updateAvailable, true);
      assert.equal(readFileSync(fixture.configFile, "utf8"), original);
      fixture.dispose();
    });
  }
});

test("advisory persistence failures resolve and never retain settled requests", async (t) => {
  const cases = [
    { name: "refused invalid", result: { status: "refused-invalid" } as const },
    { name: "write failed", result: { status: "write-failed", error: "denied" } as const },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = updateFixture(null);
      let requests = 0;
      const issues: string[] = [];
      const checker = createTweakUpdateChecker({
        request: async () => {
          requests += 1;
          return jsonResponse(200, { tag_name: "v0.2.0" });
        },
        persist: () => entry.result,
        onIssue: (message) => issues.push(message),
      });

      const first = await checker.ensure({
        configFile: fixture.configFile,
        manifest: manifest("0.1.0"),
      });
      assert.equal(first.updateAvailable, true);
      assert.deepEqual(issues, [
        `Tweak update cache ${entry.result.status}: com.example.tweak`,
      ]);

      const second = await checker.ensure({
        configFile: fixture.configFile,
        manifest: manifest("0.1.0"),
      });
      assert.equal(second.updateAvailable, true);
      assert.equal(requests, 2);
      assert.equal(issues.length, 2);
      fixture.dispose();
    });
  }
});

function manifest(version: string): TweakManifest {
  return {
    id: "com.example.tweak",
    name: "Example Tweak",
    version,
    githubRepo: "example/tweak",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function updateFixture(raw: string | null): {
  configFile: string;
  dispose(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "claudepp-tweak-update-"));
  const configFile = join(root, "config.json");
  if (raw !== null) writeFileSync(configFile, raw, "utf8");
  return {
    configFile,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
