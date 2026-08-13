import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("loads the built Main Runtime after dist is isolated from workspace node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-bundle-"));
  try {
    const isolated = join(root, "runtime");
    cpSync(resolve("packages", "runtime", "dist"), isolated, { recursive: true });
    const env = { ...process.env };
    delete env.CLAUDE_PLUSPLUS_USER_ROOT;
    delete env.CLAUDE_PLUSPLUS_RUNTIME;
    delete env.NODE_PATH;

    const run = spawnSync(process.execPath, [join(isolated, "main.js")], {
      cwd: root,
      env,
      encoding: "utf8",
    });

    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
