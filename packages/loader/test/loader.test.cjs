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

test("applies startup environment before the original Claude entry", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-loader-startup-env-"));
  try {
    const app = join(root, "app");
    const userRoot = join(root, "user");
    const runtimeRoot = join(userRoot, "runtime");
    const tweakRoot = join(userRoot, "tweaks", "com.example.startup-env");
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(tweakRoot, { recursive: true });
    mkdirSync(join(userRoot, "startup-environment"), { recursive: true });
    mkdirSync(app, { recursive: true });
    copyFileSync(resolve("packages", "loader", "loader.cjs"), join(app, "loader.cjs"));
    copyFileSync(resolve("packages", "runtime", "dist", "main.js"), join(runtimeRoot, "main.js"));
    writeFileSync(join(tweakRoot, "index.js"), "module.exports = { start() {} };\n");
    writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({
      id: "com.example.startup-env",
      name: "Startup env",
      version: "0.1.0",
      githubRepo: "example/startup-env",
      scope: "main",
      main: "index.js",
      permissions: ["startup-environment"],
      startupEnvironment: {
        keys: [
          "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
          "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
          "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
        ],
      },
    }));
    writeFileSync(
      join(userRoot, "startup-environment", "com.example.startup-env.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        variables: {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: "272000",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000",
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85",
        },
      }),
    );
    writeFileSync(join(app, "original.cjs"), `
module.exports = {
  max: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  pct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
};
`);
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({
        main: "loader.cjs",
        __claudepp: { originalMain: "original.cjs", userRoot, loaderVersion: "0.2.4" },
      }),
    );
    const env = { ...process.env };
    delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;

    const run = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", join(app, "loader.cjs")],
      { encoding: "utf8", env },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { max: "272000", window: "250000", pct: "85" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
