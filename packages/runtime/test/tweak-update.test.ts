import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import { readRuntimeConfig } from "../src/config.ts";
import {
  checkTweakRelease,
  ensureTweakUpdateCheck,
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

test("reuses a matching release check for twenty-four hours", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-tweak-update-"));
  const configFile = join(root, "config.json");
  try {
    writeFileSync(configFile, "{}\n", "utf8");
    let requests = 0;
    const request = async () => {
      requests += 1;
      return jsonResponse(200, { tag_name: "v0.2.0" });
    };
    const checkedAt = new Date("2026-08-13T10:00:00.000Z");

    await ensureTweakUpdateCheck({ configFile, manifest: manifest("0.1.0"), request, now: checkedAt });
    await ensureTweakUpdateCheck({
      configFile,
      manifest: manifest("0.1.0"),
      request,
      now: new Date(checkedAt.getTime() + TWEAK_UPDATE_INTERVAL_MS - 1),
    });

    assert.equal(requests, 1);
    assert.equal(
      readRuntimeConfig(configFile).tweakUpdateChecks["com.example.tweak"]?.latestVersion,
      "0.2.0",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
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
