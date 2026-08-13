import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReleaseDescriptor } from "../src/release-client.ts";
import {
  parseSelfUpdateArguments,
  selfUpdate,
  type SelfUpdateDependencies,
  type SelfUpdateOptions,
} from "../src/commands/self-update.ts";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";
import { readSelfUpdateState } from "../src/state.ts";

test("rejects an official asset when its SHA-256 does not match", async () => {
  const fixture = updateFixture({ expectedSha: "0".repeat(64), archiveContents: "tampered" });
  try {
    await assert.rejects(selfUpdate(fixture.options, fixture.deps), /SHA-256 mismatch/);
    assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
    assert.equal(readFileSync(fixture.currentSourceMarker, "utf8"), "current-source");
    assert.equal(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile)?.status, "failed");
  } finally {
    fixture.dispose();
  }
});

test("parses Stable, Prerelease, Custom, and watcher CLI options explicitly", () => {
  assert.deepEqual(parseSelfUpdateArguments([]), {});
  assert.deepEqual(parseSelfUpdateArguments(["--prerelease", "--watcher"]), {
    channel: "prerelease",
    watcher: true,
  });
  assert.deepEqual(parseSelfUpdateArguments(["--repo", "example/custom", "--ref", "feature/x", "--force"]), {
    channel: "custom",
    repo: "example/custom",
    ref: "feature/x",
    force: true,
  });
});

test("watcher mode returns disabled without downloading when automatic refresh is off", async () => {
  const fixture = updateFixture({ autoUpdate: false, expectedSha: "0".repeat(64) });
  try {
    const result = await selfUpdate({ ...fixture.options, watcher: true }, fixture.deps);
    assert.equal(result.status, "disabled");
    assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
  } finally {
    fixture.dispose();
  }
});

test("Custom requires a system Node 24+ toolchain", async () => {
  const fixture = updateFixture({ systemToolchain: null });
  try {
    await assert.rejects(
      selfUpdate({ ...fixture.options, channel: "custom", repo: "example/custom", ref: "main" }, fixture.deps),
      /Node\.js 24.*Custom/i,
    );
    assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
  } finally {
    fixture.dispose();
  }
});

test("a failed Custom build leaves the current source and Runtime intact", async () => {
  const fixture = updateFixture({ failCustomTest: true });
  try {
    await assert.rejects(
      selfUpdate({ ...fixture.options, channel: "custom", repo: "example/custom", ref: "main" }, fixture.deps),
      /Custom build failed/i,
    );
    assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
    assert.equal(readFileSync(fixture.currentSourceMarker, "utf8"), "current-source");
  } finally {
    fixture.dispose();
  }
});

test("watcher mode honors the persisted Custom repository and ref", async () => {
  const fixture = updateFixture({
    configChannel: "custom",
    configRepo: "example/custom",
    configRef: "master",
    failCustomTest: true,
  });
  try {
    const { channel: _channel, ...watcherOptions } = fixture.options;
    await assert.rejects(selfUpdate({ ...watcherOptions, watcher: true }, fixture.deps), /Custom build failed/i);
    const state = readSelfUpdateState(fixture.options.paths.selfUpdateStateFile);
    assert.equal(state?.channel, "custom");
    assert.equal(state?.repo, "example/custom");
    assert.match(state?.sourceLabel ?? "", /example\/custom@master/);
  } finally {
    fixture.dispose();
  }
});

test("a failed maintenance install rolls back both source and Runtime", async () => {
  const fixture = updateFixture({ failInstall: true });
  try {
    await assert.rejects(selfUpdate(fixture.options, fixture.deps), /maintenance install failed/i);
    assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
    assert.equal(readFileSync(fixture.currentSourceMarker, "utf8"), "current-source");
    assert.equal(existsSync(`${fixture.options.sourceRoot}.previous`), false);
  } finally {
    fixture.dispose();
  }
});

test("a verified official package replaces source only after maintenance succeeds", async () => {
  const fixture = updateFixture();
  try {
    const result = await selfUpdate(fixture.options, fixture.deps);
    assert.equal(result.status, "updated");
    assert.equal(readFileSync(fixture.currentSourceMarker, "utf8"), "updated-source");
    assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "partially-updated-runtime");
    assert.equal(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile)?.latestVersion, "0.3.0");
  } finally {
    fixture.dispose();
  }
});

function updateFixture(overrides: {
  expectedSha?: string;
  archiveContents?: string;
  systemToolchain?: { node: string; npm: string; version: string } | null;
  failCustomTest?: boolean;
  failInstall?: boolean;
  autoUpdate?: boolean;
  configChannel?: "stable" | "prerelease" | "custom";
  configRepo?: string;
  configRef?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudepp-self-update-"));
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    USERPROFILE: join(root, "profile"),
  });
  const sourceRoot = paths.sourceRoot;
  const currentRuntime = join(paths.runtime, "main.js");
  const currentSourceMarker = join(sourceRoot, "source-marker.txt");
  mkdirSync(paths.runtime, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(currentRuntime, "current-runtime");
  writeFileSync(currentSourceMarker, "current-source");
  mkdirSync(paths.roamingRoot, { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({
    claudePlusPlus: {
      autoUpdate: overrides.autoUpdate ?? true,
      updateChannel: overrides.configChannel,
      updateRepo: overrides.configRepo,
      updateRef: overrides.configRef,
    },
  }));

  const archiveContents = overrides.archiveContents ?? "official archive";
  const expectedSha = overrides.expectedSha ?? sha256(archiveContents);
  const descriptor: ReleaseDescriptor = {
    repo: "kpkhxlgy0/claude-plusplus",
    tag: "v0.3.0",
    version: "0.3.0",
    archiveUrl: "https://downloads.test/claude-plusplus-0.3.0-win-x64.zip",
    archiveName: "claude-plusplus-0.3.0-win-x64.zip",
    sha256Url: "https://downloads.test/claude-plusplus-0.3.0-win-x64.zip.sha256",
    releaseUrl: "https://github.com/kpkhxlgy0/claude-plusplus/releases/tag/v0.3.0",
    releaseNotes: "notes",
  };
  const options: SelfUpdateOptions = {
    paths,
    sourceRoot,
    channel: "stable",
    force: true,
  };
  const deps: SelfUpdateDependencies = {
    now: () => new Date("2026-08-13T00:00:00Z"),
    resolveRelease: async () => descriptor,
    downloadFile: async (url, target) => {
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(
        target,
        url.endsWith(".sha256") ? `${expectedSha}  ${descriptor.archiveName}\n` : archiveContents,
      );
    },
    extractZip: (_archive, target) => seedReleasePackage(target, "updated-source"),
    extractTar: (_archive, target) => {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "package.json"), JSON.stringify({ version: "0.3.0" }));
    },
    findSystemToolchain: () => overrides.systemToolchain === undefined
      ? { node: "C:\\Program Files\\nodejs\\node.exe", npm: "C:\\Program Files\\nodejs\\npm.cmd", version: "24.6.0" }
      : overrides.systemToolchain,
    run: (command, args, cwd) => {
      if (args.includes("test") && overrides.failCustomTest) {
        return { status: 1, stdout: "", stderr: "fixture build error" };
      }
      if (args.includes("package:windows")) {
        const dist = join(cwd, "dist");
        mkdirSync(dist, { recursive: true });
        const archive = join(dist, "claude-plusplus-0.3.0-win-x64.zip");
        writeFileSync(archive, archiveContents);
        writeFileSync(`${archive}.sha256`, `${sha256(archiveContents)}  claude-plusplus-0.3.0-win-x64.zip\n`);
      }
      if (args.includes("install")) {
        writeFileSync(currentRuntime, "partially-updated-runtime");
        if (overrides.failInstall) {
          return { status: 1, stdout: "", stderr: "fixture install error" };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };

  return {
    options,
    deps,
    currentRuntime,
    currentSourceMarker,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedReleasePackage(target: string, marker: string): void {
  const files = [
    "toolchain/node.exe",
    "packages/installer/dist/cli.js",
    "packages/runtime/dist/main.js",
    "packages/runtime/dist/preload/index.js",
    "packages/loader/loader.cjs",
    "bin/claudeplusplus.cmd",
    "store/index.json",
  ];
  for (const file of files) {
    const path = join(target, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.endsWith("index.json") ? '{"schemaVersion":1,"entries":[]}' : "fixture");
  }
  writeFileSync(join(target, "package.json"), JSON.stringify({ version: "0.3.0" }));
  writeFileSync(join(target, "source-marker.txt"), marker);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
