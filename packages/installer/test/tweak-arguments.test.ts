import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCreateTweakArguments,
  parseDevTweakArguments,
  parseValidateTweakArguments,
} from "../src/tweak-arguments.ts";

test("create parser accepts the complete command shape", () => {
  assert.deepEqual(parseCreateTweakArguments([
    "project", "--id", "com.example.one", "--name", "Example One",
    "--repo", "example/one", "--scope", "main", "--force",
  ]), {
    target: "project",
    id: "com.example.one",
    name: "Example One",
    repo: "example/one",
    scope: "main",
    force: true,
  });
});

test("create parser defaults force and omits unspecified values", () => {
  assert.deepEqual(parseCreateTweakArguments(["project"]), {
    target: "project",
    force: false,
  });
});

test("create parser rejects unknown options", () => {
  for (const option of ["--unknown", "-x"]) {
    assert.throws(
      () => parseCreateTweakArguments(["project", option]),
      new Error(`unknown option: ${option}`),
      option,
    );
  }
});

test("create parser requires exactly one target", () => {
  for (const argv of [[], ["one", "two"], ["--force"]]) {
    assert.throws(
      () => parseCreateTweakArguments(argv),
      new Error("create-tweak requires exactly one target"),
      JSON.stringify(argv),
    );
  }
});

test("create parser rejects every duplicate option", () => {
  const cases = [
    { flag: "--id", argv: ["project", "--id", "one", "--id", "two"] },
    { flag: "--name", argv: ["project", "--name", "One", "--name", "Two"] },
    { flag: "--repo", argv: ["project", "--repo", "one/repo", "--repo", "two/repo"] },
    { flag: "--scope", argv: ["project", "--scope", "main", "--scope", "both"] },
    { flag: "--force", argv: ["project", "--force", "--force"] },
  ];

  for (const { flag, argv } of cases) {
    assert.throws(
      () => parseCreateTweakArguments(argv),
      new Error(`duplicate option: ${flag}`),
      flag,
    );
  }
});

test("create parser reports every missing value without consuming option tokens", () => {
  for (const flag of ["--id", "--name", "--repo", "--scope"]) {
    for (const suffix of [[], ["-x"]]) {
      assert.throws(
        () => parseCreateTweakArguments(["project", flag, ...suffix]),
        new Error(`${flag} requires a value`),
        `${flag} ${suffix.join(" ")}`,
      );
    }
  }
});

test("create parser rejects scopes outside renderer, main, and both", () => {
  assert.throws(
    () => parseCreateTweakArguments(["project", "--scope", "preload"]),
    new Error("invalid --scope: preload"),
  );
});

test("validate and dev parsers apply their defaults", () => {
  assert.deepEqual(parseValidateTweakArguments([]), { target: "." });
  assert.deepEqual(parseValidateTweakArguments(["manifest.json"]), { target: "manifest.json" });
  assert.deepEqual(parseDevTweakArguments([]), {
    target: ".",
    replace: false,
    watch: true,
  });
  assert.deepEqual(parseDevTweakArguments([
    "project", "--name", "com.example.live", "--replace", "--no-watch",
  ]), {
    target: "project",
    name: "com.example.live",
    replace: true,
    watch: false,
  });
});

test("validate parser rejects unknown options and extra positionals", () => {
  for (const option of ["--unknown", "-x"]) {
    assert.throws(
      () => parseValidateTweakArguments([option]),
      new Error(`unknown option: ${option}`),
      option,
    );
  }
  assert.throws(
    () => parseValidateTweakArguments(["one", "two"]),
    new Error("validate-tweak accepts at most one target"),
  );
});

test("dev parser rejects unknown options and extra positionals", () => {
  for (const option of ["--unknown", "-x"]) {
    assert.throws(
      () => parseDevTweakArguments([option]),
      new Error(`unknown option: ${option}`),
      option,
    );
  }
  assert.throws(
    () => parseDevTweakArguments(["one", "two"]),
    new Error("dev accepts at most one target"),
  );
});

test("dev parser rejects duplicate value and boolean options", () => {
  const cases = [
    { flag: "--name", argv: ["--name", "one", "--name", "two"] },
    { flag: "--replace", argv: ["--replace", "--replace"] },
    { flag: "--no-watch", argv: ["--no-watch", "--no-watch"] },
  ];

  for (const { flag, argv } of cases) {
    assert.throws(
      () => parseDevTweakArguments(argv),
      new Error(`duplicate option: ${flag}`),
      flag,
    );
  }
});

test("dev parser reports a missing name without consuming option tokens", () => {
  for (const suffix of [[], ["-x"]]) {
    assert.throws(
      () => parseDevTweakArguments(["--name", ...suffix]),
      new Error("--name requires a value"),
      suffix.join(" "),
    );
  }
});
