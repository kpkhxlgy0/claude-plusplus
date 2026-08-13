import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TweakManifest } from "@claude-plusplus/sdk";
import {
  fetchTweakStore,
  installStoreTweak,
  normalizeStoreEntry,
  normalizeStoreRegistry,
  prepareTweakSubmission,
  type InstallStoreTweakOptions,
  type TweakStoreEntry,
} from "../src/tweak-store.ts";

test("accepts an empty schema-1 registry", () => {
  assert.deepEqual(normalizeStoreRegistry({ schemaVersion: 1, entries: [] }).entries, []);
});

test("requires the manifest repository and full reviewed commit SHA", () => {
  assert.throws(
    () => normalizeStoreEntry(storeEntry({ approvedCommitSha: "abc" })),
    /full approved commit SHA/,
  );
  assert.throws(
    () => normalizeStoreEntry(storeEntry({ repo: "owner/one", manifestRepo: "owner/two" })),
    /repo does not match manifest githubRepo/,
  );
});

test("builds platform, Runtime, and installed-state views from a reviewed registry", async () => {
  const registry = await fetchTweakStore({
    sourceUrl: "https://example.test/store/index.json",
    requestJson: async () => ({
      schemaVersion: 1,
      entries: [{
        ...storeEntry(),
        platforms: ["win32"],
        manifest: { ...manifest(), minRuntime: "0.3.0" },
      }],
    }),
    installedTweaks: [{
      dir: "C:\\Tweaks\\com.example.tweak",
      entry: "C:\\Tweaks\\com.example.tweak\\index.js",
      manifest: manifest(),
      entryExists: true,
      compatible: true,
      enabled: false,
      update: null,
    }],
    platform: "win32",
    runtimeVersion: "0.2.0",
    now: () => new Date("2026-08-13T00:00:00Z"),
  });

  assert.equal(registry.sourceUrl, "https://example.test/store/index.json");
  assert.equal(registry.fetchedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(registry.entries[0]?.platform.compatible, true);
  assert.equal(registry.entries[0]?.runtime.compatible, false);
  assert.match(registry.entries[0]?.runtime.reason ?? "", /requires Claude\+\+ 0\.3\.0/);
  assert.deepEqual(registry.entries[0]?.installed, { version: "1.0.0", enabled: false });
});

test("validates the staged manifest before replacing an installed Tweak", async () => {
  const fixture = storeInstallFixture({ stagedManifestId: "com.example.wrong" });
  try {
    await assert.rejects(installStoreTweak(fixture.options), /downloaded manifest id/i);
    assert.equal(readFileSync(fixture.currentEntry, "utf8"), "current");
  } finally {
    fixture.dispose();
  }
});

test("rejects an archive path that escapes the staging directory", async () => {
  const fixture = storeInstallFixture({ archivePath: "../../escape.txt" });
  try {
    await assert.rejects(installStoreTweak(fixture.options), /outside.*staging/i);
    assert.equal(readFileSync(fixture.currentEntry, "utf8"), "current");
  } finally {
    fixture.dispose();
  }
});

test("prepares a submission from the default branch head", async () => {
  const commitSha = "a".repeat(40);
  const submission = await prepareTweakSubmission({
    repo: "example/tweak",
    github: {
      getRepository: async () => ({ defaultBranch: "master" }),
      getCommit: async () => ({
        sha: commitSha,
        url: `https://github.com/example/tweak/commit/${commitSha}`,
      }),
      getManifest: async () => manifest(),
    },
  });

  assert.equal(submission.defaultBranch, "master");
  assert.equal(submission.commitSha, commitSha);
  assert.match(submission.issueUrl, /example%2Ftweak/);
  assert.match(submission.issueUrl, new RegExp(`a{${commitSha.length}}`));
});

test("refuses to overwrite a locally modified Store-managed Tweak", async () => {
  const fixture = storeInstallFixture();
  try {
    seedManagedInstall(fixture.target);
    writeFileSync(join(fixture.target, "index.js"), "locally modified", "utf8");

    await assert.rejects(installStoreTweak(fixture.options), /locally modified/i);
    assert.equal(readFileSync(join(fixture.target, "index.js"), "utf8"), "locally modified");
  } finally {
    fixture.dispose();
  }
});

test("replaces a clean Store-managed Tweak and records the reviewed file hashes", async () => {
  const fixture = storeInstallFixture({ stagedEntry: "updated" });
  try {
    seedManagedInstall(fixture.target);
    await installStoreTweak(fixture.options);

    assert.equal(readFileSync(join(fixture.target, "index.js"), "utf8"), "updated");
    const metadata = JSON.parse(
      readFileSync(join(fixture.target, ".claudepp-store.json"), "utf8"),
    ) as { approvedCommitSha?: string; files?: Record<string, string> };
    assert.equal(metadata.approvedCommitSha, "a".repeat(40));
    assert.deepEqual(metadata.files, {
      "index.js": sha256("updated"),
      "manifest.json": sha256(JSON.stringify(manifest())),
    });
  } finally {
    fixture.dispose();
  }
});

function storeEntry(overrides: {
  approvedCommitSha?: string;
  repo?: string;
  manifestRepo?: string;
} = {}): Record<string, unknown> {
  const repo = overrides.repo ?? "example/tweak";
  return {
    id: "com.example.tweak",
    manifest: manifest(overrides.manifestRepo ?? repo),
    repo,
    approvedCommitSha: overrides.approvedCommitSha ?? "a".repeat(40),
    approvedAt: "2026-08-13T00:00:00Z",
    approvedBy: "reviewer",
  };
}

function manifest(repo = "example/tweak", id = "com.example.tweak"): TweakManifest {
  return {
    id,
    name: "Example Tweak",
    version: "1.0.0",
    githubRepo: repo,
    scope: "both",
    main: "index.js",
  };
}

function storeInstallFixture(overrides: {
  archivePath?: string;
  stagedEntry?: string;
  stagedManifestId?: string;
} = {}): {
  options: InstallStoreTweakOptions;
  target: string;
  currentEntry: string;
  dispose(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "claudepp-store-test-"));
  const tweaksRoot = join(root, "tweaks");
  const target = join(tweaksRoot, "com.example.tweak");
  const currentEntry = join(target, "index.js");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest()));
  writeFileSync(currentEntry, "current");
  const entry = normalizeStoreEntry(storeEntry()) as TweakStoreEntry;
  const archivePath = overrides.archivePath ?? "example-tweak/source/index.js";

  return {
    target,
    currentEntry,
    options: {
      entry,
      tweaksRoot,
      registryUrl: "https://example.test/store/index.json",
      archive: {
        download: async () => Buffer.from("archive fixture"),
        list: () => [archivePath],
        extract: (_archiveFile, extractionRoot) => {
          const source = join(extractionRoot, "example-tweak");
          mkdirSync(source, { recursive: true });
          writeFileSync(
            join(source, "manifest.json"),
            JSON.stringify(manifest("example/tweak", overrides.stagedManifestId)),
          );
          writeFileSync(join(source, "index.js"), overrides.stagedEntry ?? "updated");
        },
      },
      now: () => new Date("2026-08-13T00:00:00Z"),
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedManagedInstall(target: string): void {
  const manifestText = JSON.stringify(manifest());
  writeFileSync(join(target, "manifest.json"), manifestText);
  writeFileSync(join(target, "index.js"), "current");
  writeFileSync(join(target, ".claudepp-store.json"), JSON.stringify({
    repo: "example/tweak",
    approvedCommitSha: "b".repeat(40),
    installedAt: "2026-08-12T00:00:00Z",
    storeIndexUrl: "https://example.test/store/index.json",
    files: {
      "index.js": sha256("current"),
      "manifest.json": sha256(manifestText),
    },
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
