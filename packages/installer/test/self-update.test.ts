import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
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
import { assertSafeSourceReplacement } from "../src/source-replacement.ts";

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

test("checking state identifies the updater process that owns it", async () => {
  const fixture = updateFixture();
  const resolveRelease = fixture.deps.resolveRelease;
  let checkingProcessId: number | undefined;
  try {
    fixture.deps.resolveRelease = async (options) => {
      checkingProcessId = readSelfUpdateState(
        fixture.options.paths.selfUpdateStateFile,
      )?.processId;
      return await resolveRelease(options);
    };

    const result = await selfUpdate(fixture.options, fixture.deps);

    assert.equal(checkingProcessId, process.pid);
    assert.equal(result.processId, undefined);
  } finally {
    fixture.dispose();
  }
});

test("persists updater phases and real archive progress before the terminal state", async () => {
  const fixture = updateFixture();
  const originalDownload = fixture.deps.downloadFile;
  const originalExtract = fixture.deps.extractZip;
  const originalRun = fixture.deps.run;
  const phases: Array<string | undefined> = [];
  let downloadState: ReturnType<typeof readSelfUpdateState> = null;
  try {
    fixture.deps.downloadFile = async (...args: unknown[]) => {
      const [url, target, onProgress] = args as [
        string,
        string,
        ((progress: { downloadedBytes: number; totalBytes: number | null }) => void)?,
      ];
      phases.push(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile)?.phase);
      if (!url.endsWith(".sha256")) {
        onProgress?.({ downloadedBytes: 8, totalBytes: 16 });
        downloadState = readSelfUpdateState(fixture.options.paths.selfUpdateStateFile);
      }
      await originalDownload(url, target);
    };
    fixture.deps.extractZip = (archive, target) => {
      phases.push(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile)?.phase);
      originalExtract(archive, target);
    };
    fixture.deps.run = (command, args, cwd) => {
      if (args.includes("install")) {
        phases.push(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile)?.phase);
      }
      return originalRun(command, args, cwd);
    };

    await selfUpdate(fixture.options, fixture.deps);

    assert.deepEqual(phases, ["downloading", "verifying", "extracting", "installing"]);
    assert.equal(downloadState?.status, "checking");
    assert.equal(downloadState?.processId, process.pid);
    assert.equal(downloadState?.downloadedBytes, 8);
    assert.equal(downloadState?.totalBytes, 16);
  } finally {
    fixture.dispose();
  }
});

test("default downloader records exact bytes without inventing an unknown total", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const item of [
      { contentLength: "16", expectedTotal: 16 },
      { contentLength: null, expectedTotal: null },
    ]) {
      const fixture = updateFixture();
      const archiveContents = "official archive";
      const dependencies: Partial<SelfUpdateDependencies> = { ...fixture.deps };
      delete dependencies.downloadFile;
      let extractingState: ReturnType<typeof readSelfUpdateState> = null;
      const originalExtract = dependencies.extractZip;
      dependencies.extractZip = (archive, target) => {
        extractingState = readSelfUpdateState(fixture.options.paths.selfUpdateStateFile);
        originalExtract?.(archive, target);
      };
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith(".sha256")) {
          return new Response(
            `${sha256(archiveContents)}  claude-plusplus-0.3.0-win-x64.zip\n`,
            { status: 200 },
          );
        }
        const headers = item.contentLength ? { "Content-Length": item.contentLength } : undefined;
        return new Response(archiveContents, { status: 200, headers });
      };
      try {
        await selfUpdate(fixture.options, dependencies);
        assert.equal(extractingState?.downloadedBytes, 16);
        assert.equal(extractingState?.totalBytes, item.expectedTotal);
      } finally {
        fixture.dispose();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const location of ["source", "previous"] as const) {
  for (const protection of ["git-directory", "git-file", "nested-git", "unknown", "junction"] as const) {
    test(`forced update preserves a protected ${location} (${protection}) before downloading`, async () => {
      const fixture = updateFixture();
      const target = location === "source" ? fixture.options.sourceRoot : `${fixture.options.sourceRoot}.previous`;
      const linkedTarget = join(fixture.root, "linked-data");
      try {
        if (location === "previous") seedReleasePackage(target, "previous-source");
        if (protection === "git-directory") mkdirSync(join(target, ".GiT"));
        if (protection === "git-file") writeFileSync(join(target, ".git"), "gitdir: elsewhere\n");
        if (protection === "nested-git") {
          mkdirSync(join(target, "nested", ".GIT"), { recursive: true });
          writeFileSync(join(target, "nested", ".GIT", "config"), "keep nested repository");
        }
        if (protection === "unknown" || protection === "junction") {
          rmSync(target, { recursive: true });
          mkdirSync(protection === "junction" ? linkedTarget : target, { recursive: true });
          writeFileSync(join(protection === "junction" ? linkedTarget : target, "keep.bin"), Buffer.from([0, 255, 1, 128]));
          if (protection === "junction") symlinkSync(linkedTarget, target, "junction");
        }
        const before = sourceSnapshots(fixture);
        const siblings = readdirSync(join(fixture.options.sourceRoot, "..")).sort();
        fixture.deps.resolveRelease = async () => { throw new Error("unexpected network boundary"); };

        await assert.rejects(selfUpdate(fixture.options, fixture.deps), /Refusing.*(?:Git|unrecognized|link)/i);

        assert.deepEqual(sourceSnapshots(fixture), before);
        assert.deepEqual(readdirSync(join(fixture.options.sourceRoot, "..")).sort(), siblings);
        assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
        assert.equal(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile)?.status, "failed");
      } finally {
        fixture.dispose();
      }
    });
  }
}

test("a source inside a Git ancestor is refused before creating an updater workspace", async () => {
  const fixture = updateFixture();
  try {
    writeFileSync(join(fixture.root, ".GiT"), "gitdir: outside\n");
    const before = sourceSnapshots(fixture);
    fixture.deps.resolveRelease = async () => { throw new Error("unexpected network boundary"); };
    await assert.rejects(selfUpdate(fixture.options, fixture.deps), /Refusing.*Git/i);
    assert.deepEqual(sourceSnapshots(fixture), before);
    assert.deepEqual(readdirSync(join(fixture.options.sourceRoot, "..")).sort(), ["source"]);
  } finally {
    fixture.dispose();
  }
});

test("watcher refusal records a disabled reason so repair can continue", async () => {
  const fixture = updateFixture();
  try {
    mkdirSync(join(fixture.options.sourceRoot, ".git"));
    const before = sourceSnapshots(fixture);
    fixture.deps.resolveRelease = async () => { throw new Error("unexpected network boundary"); };
    const result = await selfUpdate({ ...fixture.options, watcher: true }, fixture.deps);
    assert.equal(result.status, "disabled");
    assert.match(result.error ?? "", /Git.*install\.ps1/i);
    assert.deepEqual(readSelfUpdateState(fixture.options.paths.selfUpdateStateFile), result);
    assert.deepEqual(sourceSnapshots(fixture), before);
  } finally {
    fixture.dispose();
  }
});

for (const location of ["source", "previous"] as const) {
  test(`rechecks ${location} after download before changing either source tree`, async () => {
    const fixture = updateFixture();
    const target = location === "source" ? fixture.options.sourceRoot : `${fixture.options.sourceRoot}.previous`;
    const originalExtract = fixture.deps.extractZip;
    let before: ReturnType<typeof sourceSnapshots> | undefined;
    try {
      seedReleasePackage(`${fixture.options.sourceRoot}.previous`, "previous-source");
      fixture.deps.extractZip = (archive, destination) => {
        originalExtract(archive, destination);
        mkdirSync(join(target, ".git"));
        writeFileSync(join(target, ".git", "config"), "created while downloading");
        before = sourceSnapshots(fixture);
      };

      await assert.rejects(selfUpdate(fixture.options, fixture.deps), /Refusing.*Git/i);

      assert.deepEqual(sourceSnapshots(fixture), before);
      assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "current-runtime");
    } finally {
      fixture.dispose();
    }
  });

  for (const protection of ["git", "unknown", "junction"] as const) {
    test(`rollback preserves both trees if the ${location} becomes protected (${protection})`, async () => {
      const fixture = updateFixture({ failInstall: true });
      const originalRun = fixture.deps.run;
      let before: ReturnType<typeof sourceSnapshots> | undefined;
      try {
        fixture.deps.run = (command, args, cwd) => {
          const result = originalRun(command, args, cwd);
          if (args.includes("install")) {
            const target = location === "source" ? fixture.options.sourceRoot : `${fixture.options.sourceRoot}.previous`;
            if (protection === "git") {
              mkdirSync(join(target, ".git"));
              writeFileSync(join(target, ".git", "config"), "created during maintenance");
            } else {
              renameSync(target, join(fixture.root, "linked-data"));
              if (protection === "junction") {
                symlinkSync(join(fixture.root, "linked-data"), target, "junction");
              } else {
                mkdirSync(target);
                writeFileSync(join(target, "keep.bin"), Buffer.from([0, 255, 1, 128]));
              }
            }
            before = sourceSnapshots(fixture);
          }
          return result;
        };

        await assert.rejects(selfUpdate(fixture.options, fixture.deps), /Refusing.*(?:Git|unrecognized|link)/i);

        assert.deepEqual(sourceSnapshots(fixture), before);
        assert.equal(readFileSync(fixture.currentRuntime, "utf8"), "partially-updated-runtime");
      } finally {
        fixture.dispose();
      }
    });
  }
}

test("verified Custom packages still replace a recognized managed source", async () => {
  const fixture = updateFixture();
  try {
    const result = await selfUpdate({ ...fixture.options, channel: "custom", repo: "example/custom", ref: "branch" }, fixture.deps);
    assert.equal(result.status, "updated");
    assert.equal(result.repo, "example/custom");
    assert.equal(readFileSync(fixture.currentSourceMarker, "utf8"), "updated-source");
  } finally {
    fixture.dispose();
  }
});

test("the replacement guard rejects filesystem and actual home roots without mutating them", () => {
  assert.throws(() => assertSafeSourceReplacement(parse(homedir()).root), /filesystem or home root/);
  assert.throws(() => assertSafeSourceReplacement(realpathSync(homedir())), /filesystem or home root/);
});

test("a Windows short-name home alias cannot bypass the equal-directory guard", { skip: process.platform !== "win32" }, (context) => {
  const fixture = updateFixture();
  try {
    const aliasResult = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CLAUDEPP_TEST_SOURCE).ShortPath",
    ], {
      encoding: "utf8",
      env: { ...process.env, CLAUDEPP_TEST_SOURCE: fixture.options.sourceRoot },
      timeout: 5_000,
    });
    assert.equal(aliasResult.status, 0, aliasResult.stderr || aliasResult.error?.message);
    const alias = aliasResult.stdout.trim();
    if (alias.toLowerCase() === fixture.options.sourceRoot.toLowerCase()) {
      context.skip("The fixture volume does not expose Windows short names");
      return;
    }
    const before = sourceSnapshots(fixture);
    const result = runGuardChild(fixture.options.sourceRoot, {
      USERPROFILE: alias,
      CLAUDEPP_GUARD_REASON: "filesystem or home root",
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(sourceSnapshots(fixture), before);
  } finally {
    fixture.dispose();
  }
});

test("an unavailable Windows filesystem root is refused without looping", { skip: process.platform !== "win32" }, (context) => {
  const unusedDrive = [..."ZYXWVUTSRQPONMLKJIHGFEDCBA"].find(letter => !existsSync(`${letter}:\\`));
  if (!unusedDrive) {
    context.skip("No unavailable drive letter is available for this test");
    return;
  }
  const result = runGuardChild(`${unusedDrive}:\\source`, { CLAUDEPP_GUARD_REASON: "unavailable filesystem root" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("a linked source component is refused even when normalization would erase it", async () => {
  const fixture = updateFixture();
  const alias = join(fixture.root, "alias");
  try {
    symlinkSync(dirname(fixture.options.sourceRoot), alias, "junction");
    const before = sourceSnapshots(fixture);
    fixture.deps.resolveRelease = async () => { throw new Error("unexpected network boundary"); };
    for (const sourceRoot of [join(alias, "source"), `${alias}/../profile/.claude-plusplus/source`]) {
      await assert.rejects(selfUpdate({ ...fixture.options, sourceRoot }, fixture.deps), /Refusing.*(?:symlink|junction)/i);
      assert.deepEqual(sourceSnapshots(fixture), before);
    }
  } finally {
    fixture.dispose();
  }
});

test("unversioned Claude++ source trees can be replaced but incomplete or foreign markers cannot", () => {
  const fixture = updateFixture();
  const source = join(fixture.root, "unversioned-source");
  try {
    for (const file of [
      "install.ps1", "bin/claudeplusplus.js", "packages/installer/src/cli.ts",
      "packages/runtime/src/main.ts", "packages/loader/loader.cjs",
    ]) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      writeFileSync(join(source, file), "inert source");
    }
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "claude-plusplus" }));
    assert.doesNotThrow(() => assertSafeSourceReplacement(source));
    rmSync(join(source, "packages/installer/src/cli.ts"));
    assert.throws(() => assertSafeSourceReplacement(source), /unrecognized/);
    writeFileSync(join(fixture.options.sourceRoot, "package.json"), JSON.stringify({ name: "unrelated-tool" }));
    assert.throws(() => assertSafeSourceReplacement(fixture.options.sourceRoot), /unrecognized/);
  } finally {
    fixture.dispose();
  }
});

test("managed package rollback retains old source and Runtime byte for byte", async () => {
  const fixture = updateFixture({ failInstall: true });
  try {
    writeFileSync(join(fixture.options.sourceRoot, "local-bytes.bin"), Buffer.from([0, 255, 1, 128]));
    writeFileSync(join(fixture.options.paths.runtime, "data.bin"), Buffer.from([255, 0, 2, 127]));
    const sourceBefore = snapshot(fixture.options.sourceRoot);
    const runtimeBefore = snapshot(fixture.options.paths.runtime);

    await assert.rejects(selfUpdate(fixture.options, fixture.deps), /maintenance install failed/i);

    assert.deepEqual(snapshot(fixture.options.sourceRoot), sourceBefore);
    assert.deepEqual(snapshot(fixture.options.paths.runtime), runtimeBefore);
    assert.equal(existsSync(`${fixture.options.sourceRoot}.previous`), false);
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
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "claudepp-self-update-")));
  const paths = resolveClaudePlusPlusPaths({
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    USERPROFILE: join(root, "profile"),
  });
  const sourceRoot = paths.sourceRoot;
  const currentRuntime = join(paths.runtime, "main.js");
  const currentSourceMarker = join(sourceRoot, "source-marker.txt");
  mkdirSync(paths.runtime, { recursive: true });
  seedReleasePackage(sourceRoot, "current-source");
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
    root,
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
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "claude-plusplus", version: "0.3.0" }));
  writeFileSync(join(target, "source-marker.txt"), marker);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSnapshots(fixture: ReturnType<typeof updateFixture>): unknown[] {
  return [snapshot(fixture.options.sourceRoot), snapshot(`${fixture.options.sourceRoot}.previous`), snapshot(join(fixture.root, "linked-data"))];
}

function runGuardChild(target: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import assert from "node:assert/strict";
     import { assertSafeSourceReplacement } from ${JSON.stringify(new URL("../src/source-replacement.ts", import.meta.url).href)};
     assert.throws(() => assertSafeSourceReplacement(process.env.CLAUDEPP_GUARD_TARGET),
       new RegExp(process.env.CLAUDEPP_GUARD_REASON));`,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...env, CLAUDEPP_GUARD_TARGET: target },
    timeout: 5_000,
  });
}

function snapshot(target: string): unknown {
  if (!existsSync(target)) return null;
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return { link: readlinkSync(target) };
  if (info.isDirectory()) {
    return Object.fromEntries(readdirSync(target).sort().map(name => [name, snapshot(join(target, name))]));
  }
  return readFileSync(target).toString("hex");
}
