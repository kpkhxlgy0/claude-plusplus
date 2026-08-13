import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDiskStorage } from "../src/storage.ts";

test("persists values and isolates storage by Tweak id", () => {
  withTempDir((root) => {
    const first = createDiskStorage(root, "com.example.one");
    first.set("story", "value");
    first.flush();

    assert.equal(createDiskStorage(root, "com.example.one").get("story"), "value");
    assert.equal(createDiskStorage(root, "com.example.two").get("story", null), null);
    assert.deepEqual(readdirSync(root), ["storage"]);
    assert.deepEqual(readdirSync(join(root, "storage")), ["com.example.one.json"]);
    first.dispose();
  });
});

test("delete persists and all returns a defensive copy", () => {
  withTempDir((root) => {
    const storage = createDiskStorage(root, "com.example.copy");
    storage.set("keep", "yes");
    storage.set("remove", "no");
    const snapshot = storage.all();
    snapshot.keep = "changed";
    storage.delete("remove");
    storage.dispose();

    const reloaded = createDiskStorage(root, "com.example.copy");
    assert.equal(reloaded.get("keep"), "yes");
    assert.equal(reloaded.get("remove", null), null);
    reloaded.dispose();
  });
});

test("moves malformed JSON aside without overwriting its evidence", () => {
  withTempDir((root) => {
    const dir = join(root, "storage");
    const file = join(dir, "com.example.corrupt.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{not json", "utf8");

    const storage = createDiskStorage(root, "com.example.corrupt");

    assert.deepEqual(storage.all(), {});
    assert.equal(existsSync(file), false);
    const quarantined = readdirSync(dir).find((name) =>
      /^com\.example\.corrupt\.json\.corrupt-\d+$/.test(name));
    assert.ok(quarantined);
    assert.equal(readFileSync(join(dir, quarantined), "utf8"), "{not json");
    storage.dispose();
  });
});

test("sanitizes Tweak ids before constructing storage filenames", () => {
  withTempDir((root) => {
    const storage = createDiskStorage(root, "unsafe/id:with*chars");
    storage.set("ok", true);
    storage.dispose();

    assert.equal(existsSync(join(root, "storage", "unsafe_id_with_chars.json")), true);
  });
});

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-storage-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
