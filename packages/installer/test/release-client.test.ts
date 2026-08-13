import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OFFICIAL_REPO,
  parseReleaseChecksum,
  resolveRelease,
  verifySha256,
  type GitHubRelease,
} from "../src/release-client.ts";

test("selects prereleases only for the prerelease channel", async () => {
  const stable = await resolveRelease({ channel: "stable", repo: OFFICIAL_REPO }, fakeReleases());
  const preview = await resolveRelease({ channel: "prerelease", repo: OFFICIAL_REPO }, fakeReleases());

  assert.equal(stable.tag, "v0.2.0");
  assert.equal(stable.archiveName, "claude-plusplus-0.2.0-win-x64.zip");
  assert.equal(preview.tag, "v0.3.0-beta.1");
  assert.equal(preview.archiveName, "claude-plusplus-0.3.0-beta.1-win-x64.zip");
});

test("requires both the official Windows archive and its checksum asset", async () => {
  const releases = fakeReleases();
  releases[1] = { ...releases[1], assets: releases[1].assets?.slice(0, 1) };

  await assert.rejects(
    resolveRelease({ channel: "stable", repo: OFFICIAL_REPO }, releases),
    /checksum asset/i,
  );
});

test("parses exactly one checksum for the selected archive", () => {
  const archive = "claude-plusplus-0.2.0-win-x64.zip";
  const digest = "a".repeat(64);
  assert.equal(parseReleaseChecksum(`${digest}  ${archive}\n`, archive), digest);
  assert.throws(
    () => parseReleaseChecksum(`${digest}  ${archive}\n${"b".repeat(64)}  ${archive}\n`, archive),
    /exactly one/i,
  );
});

test("rejects a file whose SHA-256 does not match", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-release-client-"));
  try {
    const file = join(root, "archive.zip");
    writeFileSync(file, "tampered");
    assert.throws(() => verifySha256(file, "0".repeat(64)), /SHA-256 mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeReleases(): GitHubRelease[] {
  return [
    release("v0.3.0-beta.1", true),
    release("v0.2.0", false),
  ];
}

function release(tag: string, prerelease: boolean): GitHubRelease {
  const version = tag.slice(1);
  const archive = `claude-plusplus-${version}-win-x64.zip`;
  return {
    tag_name: tag,
    html_url: `https://github.com/${OFFICIAL_REPO}/releases/tag/${tag}`,
    body: `${tag} notes`,
    draft: false,
    prerelease,
    assets: [
      { name: archive, browser_download_url: `https://downloads.test/${archive}` },
      { name: `${archive}.sha256`, browser_download_url: `https://downloads.test/${archive}.sha256` },
    ],
  };
}
