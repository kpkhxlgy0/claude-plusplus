import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sourceCli = join(repositoryRoot, "packages", "installer", "src", "cli.ts");
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const helpCases = [
  {
    command: "create-tweak",
    description: "Scaffold a new local Tweak",
    usage: "$ claudeplusplus create-tweak <target> [options]",
    options: [
      "--id <id>",
      "--name <display-name>",
      "--repo <owner/repo>",
      "--scope renderer|main|both",
      "--force",
      "-h, --help",
    ],
    absent: ["--no-watch"],
  },
  {
    command: "validate-tweak",
    description: "Validate a Tweak manifest and entry point",
    usage: "$ claudeplusplus validate-tweak [target] [options]",
    options: ["-h, --help"],
    absent: ["--id <id>", "--no-watch"],
  },
  {
    command: "dev",
    description: "Link a Tweak into the Claude++ Tweaks directory for local development",
    usage: "$ claudeplusplus dev [target] [options]",
    options: ["--name <link-name>", "--replace", "--no-watch", "-h, --help"],
    absent: ["--scope renderer|main|both"],
  },
] as const;

for (const helpCase of helpCases) {
  for (const helpFlag of ["-h", "--help"] as const) {
    test(`source CLI ${helpCase.command} ${helpFlag} prints command help without profile mutation`, () => {
      withDisposableCliProfile(({ env, workspace, root }) => {
        const before = snapshotTree(root);

        const result = runSourceCli([helpCase.command, helpFlag], workspace, env);

        assert.equal(result.status, 0, result.output);
        assert.equal(result.stderr, "");
        assert.match(
          result.stdout,
          new RegExp(`Description\\r?\\n\\s+${escapeRegExp(helpCase.description)}`),
        );
        assert.match(result.stdout, new RegExp(escapeRegExp(helpCase.usage)));
        assert.ok(result.stdout.indexOf("Description") < result.stdout.indexOf("Usage"));
        assert.ok(result.stdout.indexOf("Usage") < result.stdout.indexOf("Options"));
        for (const option of helpCase.options) assert.match(result.stdout, new RegExp(escapeRegExp(option)));
        for (const option of helpCase.absent) assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(option)));
        assert.deepEqual(snapshotTree(root), before);
      });
    });
  }
}

test("source CLI keeps mixed help invocations under strict argument parsing", () => {
  withDisposableCliProfile(({ env, workspace, root }) => {
    const before = snapshotTree(root);
    for (const helpCase of helpCases) {
      for (const helpFlag of ["-h", "--help"] as const) {
        const result = runSourceCli([helpCase.command, helpFlag, "extra"], workspace, env);

        assert.equal(result.status, 1, result.output);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr.trim(), `unknown option: ${helpFlag}`);
        assert.deepEqual(snapshotTree(root), before);
      }
    }
  });
});

test("source CLI does not treat prototype or unknown command names as command help", () => {
  withDisposableCliProfile(({ env, workspace, root }) => {
    const before = snapshotTree(root);
    for (const [command, helpFlag] of [
      ["toString", "-h"],
      ["__proto__", "--help"],
      ["unknown", "-h"],
    ]) {
      const result = runSourceCli([command!, helpFlag!], workspace, env);

      assert.equal(result.status, 1, result.output);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), `Unknown Claude++ command: ${command}`);
      assert.deepEqual(snapshotTree(root), before);
    }
  });
});

function runSourceCli(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; output: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxImport, sourceCli, ...argv],
    { cwd, env, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

function withDisposableCliProfile(
  run: (fixture: { root: string; workspace: string; env: NodeJS.ProcessEnv }) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-tweak-cli-"));
  try {
    const workspace = join(root, "workspace");
    const appData = join(root, "profile", "appdata");
    const localAppData = join(root, "profile", "localappdata");
    const userProfile = join(root, "profile");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(localAppData, { recursive: true });
    writeFileSync(join(userProfile, "sentinel.txt"), "unchanged", "utf8");
    run({
      root,
      workspace,
      env: {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        USERPROFILE: userProfile,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshotTree(root: string): string[] {
  const snapshot: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        snapshot.push(`link:${name}:${readlinkSync(path)}`);
      } else if (stat.isDirectory()) {
        snapshot.push(`directory:${name}`);
        visit(path);
      } else {
        snapshot.push(`file:${name}:${readFileSync(path).toString("base64")}`);
      }
    }
  };
  visit(root);
  return snapshot.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
