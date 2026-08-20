import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryCli } from "../src/cli-recovery.ts";

test("uninstall propagates purge and reports residual warnings", async () => {
  const cases: Array<{ args: string[]; purged: boolean }> = [
    { args: [], purged: false },
    { args: ["--purge"], purged: true },
  ];
  for (const { args, purged } of cases) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const uninstallOptions: Array<{ purge?: boolean }> = [];
    assert.equal(await runRecoveryCli("uninstall", args, {
      io: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      uninstall: async (options) => {
        uninstallOptions.push(options);
        return { warnings: ["locked managed mirror"] };
      },
    }), true);
    assert.deepEqual(uninstallOptions, [{ purge: purged }]);
    assert.deepEqual(JSON.parse(stdout.join("\n")), {
      uninstalled: true,
      purged,
      warnings: ["locked managed mirror"],
    });
    assert.deepEqual(stderr, ["warning: locked managed mirror"]);
  }
});

test("recovery CLI declines every unaffected command", async () => {
  assert.equal(await runRecoveryCli("status", [], {
    io: { stdout: () => assert.fail("unexpected output"), stderr: () => {} },
    uninstall: async () => assert.fail("unexpected uninstall"),
  }), false);
});
