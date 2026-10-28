import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCliLauncher } from "../src/cli-launcher.ts";
import { resolveClaudePlusPlusPaths } from "../src/paths.ts";

test("the stable CLI launcher preserves literal source paths, arguments, caller directory, and exit status", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cli-launcher-"));
  try {
    const paths = resolveClaudePlusPlusPaths({ APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), USERPROFILE: join(root, "profile") });
    const sourceRoot = join(root, "source space & %CLAUDEPP_TEST_EXPANSION% !bang!");
    const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
    const output = join(root, "invocation.json");
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), node: process.execPath })); process.exitCode = 17;`);
    const launcher = installCliLauncher(paths, sourceRoot, process.execPath);
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:on", "/s", "/c", `""${launcher}" "hello world" --flag=value"`], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, CLAUDEPP_TEST_EXPANSION: "wrong-source", bang: "wrong-bang" },
    });
    assert.equal(result.status, 17, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { args: ["hello world", "--flag=value"], cwd: root, node: process.execPath });
    assert.equal(existsSync(join(sourceRoot, "bin", "claudeplusplus.cmd")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the stable CLI launcher runs Unicode source and Node paths under code page 936 and restores it", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-cli-unicode-"));
  try {
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), USERPROFILE: join(root, "profile"),
    });
    const sourceRoot = join(root, "中文源码");
    const nodeRuntimePath = join(root, "中文运行时", "node.exe");
    const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
    const output = join(root, "invocation.json");
    mkdirSync(join(cli, ".."), { recursive: true });
    mkdirSync(join(nodeRuntimePath, ".."), { recursive: true });
    try {
      linkSync(process.execPath, nodeRuntimePath);
    } catch {
      copyFileSync(process.execPath, nodeRuntimePath);
    }
    writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), node: process.execPath })); process.exitCode = 17;`);
    const launcher = installCliLauncher(paths, sourceRoot, nodeRuntimePath);
    const wrapper = join(root, "invoke.cmd");
    const codePageAfter = join(root, "code-page-after.txt");
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      'for /f "tokens=2 delims=:" %%c in (\'chcp\') do set "_testOriginalCodePage=%%c"',
      "chcp 936 >nul",
      'call "%CLAUDEPP_TEST_LAUNCHER%" "hello world" "%CLAUDEPP_TEST_UNICODE_ARG%" --flag=value',
      'set "_testExitCode=%errorlevel%"',
      'chcp >"%CLAUDEPP_TEST_CODE_PAGE_AFTER%"',
      "chcp %_testOriginalCodePage% >nul",
      "exit /b %_testExitCode%",
      "",
    ].join("\r\n"));
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:on", "/s", "/c", `""${wrapper}""`], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: {
        ...process.env,
        CLAUDEPP_TEST_LAUNCHER: launcher,
        CLAUDEPP_TEST_CODE_PAGE_AFTER: codePageAfter,
        CLAUDEPP_TEST_UNICODE_ARG: "中文参数",
      },
    });
    assert.equal(result.status, 17, result.stderr || result.error?.message);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      args: ["hello world", "中文参数", "--flag=value"], cwd: root, node: nodeRuntimePath,
    });
    assert.match(readFileSync(codePageAfter, "utf8"), /936\s*$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
