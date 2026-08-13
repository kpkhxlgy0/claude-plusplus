const assert = require("node:assert/strict");
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("loads the external Runtime before the original Claude entry", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-loader-"));
  try {
    const app = join(root, "app");
    const userRoot = join(root, "user");
    mkdirSync(join(userRoot, "runtime"), { recursive: true });
    mkdirSync(app, { recursive: true });
    copyFileSync(resolve("packages", "loader", "loader.cjs"), join(app, "loader.cjs"));
    writeFileSync(join(userRoot, "runtime", "main.js"), "global.__claudePlusPlusRuntime = 'ready';\n");
    writeFileSync(
      join(app, "original.cjs"),
      "module.exports = { runtime: global.__claudePlusPlusRuntime, root: process.env.CLAUDE_PLUSPLUS_USER_ROOT };\n",
    );
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({
        main: "loader.cjs",
        __claudepp: { originalMain: "original.cjs", userRoot, loaderVersion: "0.2.0" },
      }),
    );

    const run = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", join(app, "loader.cjs")],
      { encoding: "utf8" },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { runtime: "ready", root: userRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls through to the original Claude entry when the external Runtime fails", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-loader-fallback-"));
  try {
    const app = join(root, "app");
    const userRoot = join(root, "user");
    mkdirSync(join(userRoot, "runtime"), { recursive: true });
    mkdirSync(app, { recursive: true });
    copyFileSync(resolve("packages", "loader", "loader.cjs"), join(app, "loader.cjs"));
    writeFileSync(join(userRoot, "runtime", "main.js"), "throw new Error('broken runtime');\n");
    writeFileSync(join(app, "original.cjs"), "module.exports = 'original-loaded';\n");
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({
        main: "loader.cjs",
        __claudepp: { originalMain: "original.cjs", userRoot, loaderVersion: "0.2.0" },
      }),
    );

    const run = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", join(app, "loader.cjs")],
      { encoding: "utf8" },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout), "original-loaded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
