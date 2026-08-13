import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTweakFs } from "../src/tweak-fs.ts";

test("reads and writes only inside the Tweak data directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-fs-"));
  try {
    const fs = createTweakFs(root, "com.example.one");

    await fs.write("notes/state.json", "ok");

    assert.equal(await fs.read("notes/state.json"), "ok");
    assert.equal(await fs.exists("notes/state.json"), true);
    assert.equal(await fs.exists("notes/missing.json"), false);
    assert.equal(fs.dataDir, join(root, "tweak-data", "com.example.one"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects traversal, absolute, UNC, and control-character paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-fs-boundary-"));
  try {
    const fs = createTweakFs(root, "com.example.one");

    await assert.rejects(() => fs.write("..\\other\\escape.txt", "bad"), /outside tweak data directory/);
    await assert.rejects(() => fs.read("D:\\absolute.txt"), /relative path/);
    await assert.rejects(() => fs.exists("\\\\server\\share\\x"), /relative path/);
    await assert.rejects(() => fs.write("file.txt\u0000suffix", "bad"), /invalid path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizes the Tweak id used for its data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-fs-id-"));
  try {
    const fs = createTweakFs(root, "unsafe/id:with*chars");

    assert.equal(fs.dataDir, join(root, "tweak-data", "unsafe_id_with_chars"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
