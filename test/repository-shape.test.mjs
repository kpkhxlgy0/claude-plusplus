import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("uses the Claude++ four-package topology", () => {
  assert.deepEqual(rootPackage.workspaces, ["packages/*"]);
  assert.equal(rootPackage.name, "claude-plusplus");
  for (const name of ["installer", "loader", "runtime", "sdk"]) {
    assert.equal(existsSync(new URL(`../packages/${name}/package.json`, import.meta.url)), true);
  }
  for (const name of ["claude-host", "native-host"]) {
    assert.equal(existsSync(new URL(`../packages/${name}`, import.meta.url)), false);
  }
});

test("uses version 0.2.3 across the root and every workspace package", () => {
  assert.equal(rootPackage.version, "0.2.3");
  for (const name of ["installer", "loader", "runtime", "sdk"]) {
    const packageJson = JSON.parse(
      readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8"),
    );
    assert.equal(packageJson.version, "0.2.3", `${name} package version`);
  }
});

test("records the exact Codex++ provenance", () => {
  const notice = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.match(notice, /b-nnett\/codex-plusplus/);
  assert.match(notice, /f98e7e9d1fa068dde9e0dddfb43b128acb4e2fd7/);
  assert.match(notice, /Copyright \(c\) 2026 Bennett/);
});

test("limits the public Claude host adapter to focused session-reference resolution", () => {
  const sdk = readFileSync(new URL("../packages/sdk/src/index.ts", import.meta.url), "utf8");
  const adapter = readFileSync(
    new URL("../packages/runtime/src/preload/claude-sessions-adapter.ts", import.meta.url),
    "utf8",
  );
  assert.match(sdk, /resolveFile\(sessionId: string, filePath: string\): Promise<string \| null>/);
  assert.match(
    sdk,
    /resolveReference\([\s\S]*occurrence: number,[\s\S]*visibleCount: number,[\s\S]*\): Promise<string \| null>/,
  );
  assert.match(sdk, /getWorkspaceRoot\(sessionId: string\): Promise<string \| null>/);
  assert.match(adapter, /LocalSessions_\$_resolveSessionFile/);
  assert.match(adapter, /LocalSessions_\$_getTranscript/);
  assert.match(adapter, /LocalSessions_\$_getSession/);

  const forbidden =
    /ClaudeDraft|ClaudeWorkspaceTrust|claude-composer|claude-workspace-trust|epitaxy-draft/;
  const roots = [
    new URL("../packages/sdk/src/", import.meta.url),
    new URL("../packages/runtime/src/", import.meta.url),
  ];

  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      assert.doesNotMatch(readFileSync(file, "utf8"), forbidden, file.pathname);
    }
  }
});

test("keeps workflow protocols and private compatibility probes out of core", () => {
  const removed = [
    "../packages/runtime/src/protocol-probe.ts",
    "../packages/runtime/test/protocol-probe.test.ts",
    "../scripts/install-feasibility-probe.ps1",
    "../scripts/remove-feasibility-probe.ps1",
    "../scripts/run-feasibility-check.ps1",
  ];
  for (const path of removed) assert.equal(existsSync(new URL(path, import.meta.url)), false, path);

  const forbidden = /unsupported_claude_build|epitaxy-draft/;
  for (const root of [
    new URL("../packages/installer/src/", import.meta.url),
    new URL("../scripts/", import.meta.url),
  ]) {
    for (const file of sourceFiles(root)) {
      assert.doesNotMatch(readFileSync(file, "utf8"), forbidden, file.pathname);
    }
  }
});

test("ships an empty public Tweak Store", () => {
  const source = readFileSync(new URL("../store/index.json", import.meta.url), "utf8");
  const store = JSON.parse(source);
  assert.deepEqual(store, { schemaVersion: 1, entries: [] });
});

test("documents the release commands and opt-in maintenance defaults", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const command of [
    "claudeplusplus install [--cleanup-all-old]",
    "claudeplusplus watcher enable",
    "claudeplusplus watcher disable",
    "claudeplusplus watcher status",
    "claudeplusplus update",
    "claudeplusplus update --repo owner/repo --ref ref",
    "claudeplusplus uninstall [--purge]",
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(command)), command);
  }
  assert.match(readme, /Watcher and automatic refresh are off by default/i);
  assert.match(readme, /Stable and Prerelease.*do not require.*system Node\.js/is);
  assert.match(readme, /Custom.*Node\.js 24\+/is);
  assert.match(readme, /Store starts empty/i);
  assert.match(readme, /Private workflow Tweaks.*distributed.*separately/is);
});

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) files.push(...sourceFiles(child));
    else if (statSync(child).isFile()) files.push(child);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
