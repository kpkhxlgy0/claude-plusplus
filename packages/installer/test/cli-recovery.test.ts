import assert from "node:assert/strict";
import test from "node:test";
import type { SafeModeAction } from "../src/commands/safe-mode.ts";
import { RECOVERY_HELP_TEXT, runRecoveryCli } from "../src/cli-recovery.ts";

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

test("CLI maps every Safe Mode form to the action and exact JSON result", async () => {
  for (const [args, expectedAction, result] of [
    [[], "on", { safeMode: true, changed: true, restartRequired: true }],
    [["--on"], "on", { safeMode: true, changed: false, restartRequired: true }],
    [["--off"], "off", { safeMode: false, changed: true, restartRequired: true }],
    [["--status"], "status", { safeMode: false, changed: false, restartRequired: false }],
  ] as const) {
    const stdout: string[] = [];
    const actions: SafeModeAction[] = [];
    assert.equal(await runRecoveryCli("safe-mode", [...args], {
      io: { stdout: (line) => stdout.push(line), stderr: () => {} },
      safeMode: (action) => { actions.push(action); return result; },
    }), true);
    assert.deepEqual(actions, [expectedAction]);
    assert.deepEqual(JSON.parse(stdout.join("\n")), result);
  }
});

test("CLI rejects conflicting Safe Mode flags and help explains restart behavior", async () => {
  await assert.rejects(
    runRecoveryCli("safe-mode", ["--on", "--off"], {
      io: { stdout: () => {}, stderr: () => {} },
    }),
    /only one/i,
  );
  const help = RECOVERY_HELP_TEXT;
  assert.match(help, /safe-mode \[--on\|--off\|--status\]/);
  assert.match(help, /Main Tweaks.*reload immediately/i);
  assert.match(help, /restart Claude.*Renderer/i);
});
