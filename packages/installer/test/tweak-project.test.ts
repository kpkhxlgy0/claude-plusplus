import assert from "node:assert/strict";
import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateTweak } from "../src/commands/validate-tweak.ts";
import type { TweakCommandOutput } from "../src/tweak-output.ts";
import {
  inspectTweakProject,
  requireValidInspection,
  requireValidTweakProject,
} from "../src/tweak-project.ts";

const validManifest = {
  id: "com.example.valid",
  name: "Valid",
  version: "0.1.0",
  githubRepo: "example/valid",
  scope: "both" as const,
  main: "index.js",
};

test("project inspection resolves a directory and a direct manifest without executing its entry", () => {
  withTempDir((root) => {
    const marker = join(root, "entry-executed");
    writeManifest(root, validManifest);
    writeFileSync(
      join(root, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    );

    const directoryInspection = inspectTweakProject(root);
    assert.equal(directoryInspection.sourceDir, root);
    assert.equal(directoryInspection.manifestPath, join(root, "manifest.json"));
    assert.equal(directoryInspection.entryPath, join(root, "index.js"));
    assert.deepEqual(directoryInspection.manifest, validManifest);
    assert.deepEqual(directoryInspection.errors, []);
    assert.deepEqual(directoryInspection.warnings, []);

    const manifestInspection = inspectTweakProject(join(root, "manifest.json"));
    assert.equal(manifestInspection.sourceDir, root);
    assert.equal(manifestInspection.manifestPath, join(root, "manifest.json"));
    assert.equal(manifestInspection.entryPath, join(root, "index.js"));
    assert.equal(existsSync(marker), false);

    const output = captureOutput();
    assert.doesNotThrow(() => validateTweak(root, output.output));
    assert.equal(existsSync(marker), false);
  });
});

test("project inspection uses manifest.main before index.js/index.cjs/index.mjs", () => {
  withTempDir((root) => {
    writeManifest(root, { ...validManifest, main: "src/main.cjs" });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.cjs"), "module.exports = {};\n");
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "src", "main.cjs"));

    const fallbackManifest = { ...validManifest };
    delete (fallbackManifest as Partial<typeof validManifest>).main;
    writeManifest(root, fallbackManifest);
    rmSync(join(root, "index.js"));
    writeFileSync(join(root, "index.mjs"), "export default {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "index.mjs"));
    writeFileSync(join(root, "index.cjs"), "module.exports = {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "index.cjs"));
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    assert.equal(inspectTweakProject(root).entryPath, join(root, "index.js"));
  });
});

test("project inspection reports missing targets, manifests, and malformed JSON", () => {
  withTempDir((root) => {
    const missingTarget = join(root, "missing");
    assert.throws(
      () => inspectTweakProject(missingTarget),
      new Error(`target does not exist: ${resolve(missingTarget)}`),
    );

    assert.throws(
      () => inspectTweakProject(root),
      new Error(`manifest not found: ${join(root, "manifest.json")}`),
    );

    writeFileSync(join(root, "manifest.json"), "{ not json", "utf8");
    assert.throws(
      () => inspectTweakProject(root),
      /manifest is not valid JSON:/,
    );
  });
});

test("project inspection returns every SDK error and warning before entry resolution", () => {
  withTempDir((root) => {
    writeManifest(root, {
      id: "bad id",
      name: "",
      version: "bad",
      githubRepo: "bad",
    });
    writeFileSync(join(root, "index.js"), "throw new Error('must not execute');\n");

    const inspection = inspectTweakProject(root);
    assert.equal(inspection.manifest, null);
    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      { path: "name", message: "name is required and must be a non-empty string" },
      {
        path: "id",
        message: "id may only contain letters, numbers, dots, underscores, and dashes",
      },
      { path: "githubRepo", message: "githubRepo must use owner/repo format" },
    ]);
    assert.deepEqual(inspection.warnings, [
      { path: "version", message: "version should be semver, for example 0.2.0" },
      { path: "scope", message: "scope is omitted and defaults to both" },
    ]);
  });
});

test("project inspection reports exact explicit and fallback missing-entry issues", () => {
  withTempDir((root) => {
    writeManifest(root, { ...validManifest, main: "src/missing.cjs" });
    const explicit = inspectTweakProject(root);
    assert.deepEqual(explicit.errors, [
      { path: "main", message: "entry file does not exist: src/missing.cjs" },
    ]);
    assert.equal(explicit.manifest?.id, validManifest.id);
    assert.equal(explicit.entryPath, null);

    const fallbackManifest = { ...validManifest };
    delete (fallbackManifest as Partial<typeof validManifest>).main;
    writeManifest(root, fallbackManifest);
    const fallback = inspectTweakProject(root);
    assert.deepEqual(fallback.errors, [
      {
        path: "main",
        message: "no entry file found; expected one of index.js, index.cjs, index.mjs",
      },
    ]);
    assert.equal(fallback.entryPath, null);
  });
});

test("project inspection reports a missing entry when the source disappears after manifest reading", () => {
  for (const fixture of [
    {
      manifest: validManifest,
      expected: "entry file does not exist: index.js",
    },
    {
      manifest: (({ main: _main, ...manifest }) => manifest)(validManifest),
      expected: "no entry file found; expected one of index.js, index.cjs, index.mjs",
    },
  ]) {
    withTempDir((root) => {
      writeManifest(root, fixture.manifest);
      writeFileSync(join(root, "index.js"), "module.exports = {};\n");

      const inspection = withSourceCanonicalization(root, () => {
        rmSync(root, { recursive: true, force: true });
      }, () => inspectTweakProject(root));

      assert.equal(inspection.entryPath, null);
      assert.deepEqual(inspection.errors, [
        { path: "main", message: fixture.expected },
      ]);
    });
  }
});

test("project inspection preserves non-missing source canonicalization errors", () => {
  withTempDir((root) => {
    writeManifest(root, validManifest);
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    const denied = Object.assign(new Error("source canonicalization denied"), {
      code: "EACCES",
    });

    assert.throws(
      () => withSourceCanonicalization(root, () => {
        throw denied;
      }, () => inspectTweakProject(root)),
      (error: unknown) => error === denied,
    );
  });
});

test("project inspection rejects an explicit entry that traverses outside the project", () => {
  withTempDir((root) => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(root, "outside.js"), "module.exports = {};\n");
    writeManifest(project, { ...validManifest, main: "../outside.js" });

    const inspection = inspectTweakProject(project);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          "entry file must resolve to a regular file inside the Tweak source project: ../outside.js",
      },
    ]);
  });
});

test("project inspection rejects an absolute entry outside the project", () => {
  withTempDir((root) => {
    const project = join(root, "project");
    const outside = join(root, "outside.js");
    mkdirSync(project);
    writeFileSync(outside, "module.exports = {};\n");
    writeManifest(project, { ...validManifest, main: outside });

    const inspection = inspectTweakProject(project);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          `entry file must resolve to a regular file inside the Tweak source project: ${outside}`,
      },
    ]);
  });
});

test("project inspection rejects an absolute entry even when its file is inside the project", () => {
  withTempDir((root) => {
    const entry = join(root, "index.js");
    writeFileSync(entry, "module.exports = {};\n");
    writeManifest(root, { ...validManifest, main: entry });

    const inspection = inspectTweakProject(root);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          `entry file must resolve to a regular file inside the Tweak source project: ${entry}`,
      },
    ]);
  });
});

test("project inspection rejects a Windows drive-relative entry", () => {
  withTempDir((root) => {
    writeFileSync(join(root, "foo"), "module.exports = {};\n");
    writeManifest(root, { ...validManifest, main: "C:foo" });

    const inspection = inspectTweakProject(root);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          "entry file must resolve to a regular file inside the Tweak source project: C:foo",
      },
    ]);
  });
});

test("project inspection rejects a dot-dot entry even when it resolves inside the project", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    writeManifest(root, { ...validManifest, main: "nested/../index.js" });

    const inspection = inspectTweakProject(root);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          "entry file must resolve to a regular file inside the Tweak source project: nested/../index.js",
      },
    ]);
  });
});

test("project inspection rejects a project-local link whose canonical target escapes", () => {
  withTempDir((root) => {
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(outside, "index.js"), "module.exports = {};\n");
    symlinkSync(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
    writeManifest(project, { ...validManifest, main: "linked/index.js" });

    const inspection = inspectTweakProject(project);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          "entry file must resolve to a regular file inside the Tweak source project: linked/index.js",
      },
    ]);
  });
});

test("project inspection rejects an explicit directory entry", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "index.js"));
    writeManifest(root, validManifest);

    const inspection = inspectTweakProject(root);

    assert.equal(inspection.entryPath, null);
    assert.deepEqual(inspection.errors, [
      {
        path: "main",
        message:
          "entry file must resolve to a regular file inside the Tweak source project: index.js",
      },
    ]);
  });
});

test("project inspection skips fallback directories and keeps regular-file precedence", () => {
  withTempDir((root) => {
    const fallbackManifest = { ...validManifest };
    delete (fallbackManifest as Partial<typeof validManifest>).main;
    writeManifest(root, fallbackManifest);
    mkdirSync(join(root, "index.js"));

    const directoryOnly = inspectTweakProject(root);
    assert.equal(directoryOnly.entryPath, null);
    assert.deepEqual(directoryOnly.errors, [
      {
        path: "main",
        message: "no entry file found; expected one of index.js, index.cjs, index.mjs",
      },
    ]);

    writeFileSync(join(root, "index.cjs"), "module.exports = {};\n");
    const withRegularFallback = inspectTweakProject(root);
    assert.equal(withRegularFallback.entryPath, join(root, "index.cjs"));
    assert.deepEqual(withRegularFallback.errors, []);
  });
});

test("valid-project narrowing rejects an inconsistent empty-error inspection", () => {
  for (const inconsistent of [
    { manifest: null, entryPath: "C:\\tweak\\index.js" },
    { manifest: validManifest, entryPath: null },
  ]) {
    assert.throws(
      () => requireValidInspection({
        sourceDir: "C:\\tweak",
        manifestPath: "C:\\tweak\\manifest.json",
        ...inconsistent,
        errors: [],
        warnings: [],
      }),
      new Error("invalid Tweak project inspection: manifest and entryPath are required"),
    );
  }
});

test("the valid-project helpers preserve warnings and aggregate every error", () => {
  withTempDir((root) => {
    writeManifest(root, {
      id: "bad id",
      name: "",
      version: "bad",
      githubRepo: "bad",
    });
    const invalid = inspectTweakProject(root);
    assert.throws(
      () => requireValidInspection(invalid),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          [
            "name: name is required and must be a non-empty string",
            "id: id may only contain letters, numbers, dots, underscores, and dashes",
            "githubRepo: githubRepo must use owner/repo format",
          ].join("\n"),
        );
        return true;
      },
    );
    assert.throws(
      () => requireValidTweakProject(root),
      /name: name is required[\s\S]+id: id may only contain[\s\S]+githubRepo:/,
    );

    writeManifest(root, {
      id: validManifest.id,
      name: validManifest.name,
      version: validManifest.version,
      githubRepo: validManifest.githubRepo,
      main: validManifest.main,
    });
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    const project = requireValidTweakProject(root);
    assert.equal(project.manifest.id, validManifest.id);
    assert.equal(project.entryPath, join(root, "index.js"));
    assert.deepEqual(project.errors, []);
    assert.deepEqual(project.warnings, [
      { path: "scope", message: "scope is omitted and defaults to both" },
    ]);
  });
});

test("validate reporter prints every warning but warnings do not fail", () => {
  withTempDir((root) => {
    writeManifest(root, {
      id: validManifest.id,
      name: validManifest.name,
      version: "next",
      githubRepo: validManifest.githubRepo,
      main: validManifest.main,
    });
    writeFileSync(join(root, "index.js"), "module.exports = {};\n");
    const messages = captureOutput();

    const project = validateTweak(root, messages.output);

    assert.equal(project.manifest.id, validManifest.id);
    assert.deepEqual(messages.error, []);
    assert.deepEqual(messages.warn, [
      "warn version: version should be semver, for example 0.2.0",
      "warn scope: scope is omitted and defaults to both",
    ]);
    assert.deepEqual(messages.log, [
      `valid ${validManifest.id} (${join(root, "index.js")})`,
    ]);
  });
});

test("validate reporter narrows the same project inspection it reports", () => {
  withTempDir((root) => {
    writeManifest(root, {
      id: validManifest.id,
      name: validManifest.name,
      version: validManifest.version,
      githubRepo: validManifest.githubRepo,
      main: validManifest.main,
    });
    const entryPath = join(root, "index.js");
    writeFileSync(entryPath, "module.exports = {};\n");
    const messages = captureOutput();
    messages.output.warn = () => rmSync(entryPath);

    const project = validateTweak(root, messages.output);

    assert.equal(project.entryPath, entryPath);
    assert.equal(existsSync(entryPath), false);
  });
});

test("validate reporter prints every error and warning before one summary failure", () => {
  withTempDir((root) => {
    writeManifest(root, {
      id: "bad id",
      name: "",
      version: "bad",
      githubRepo: "bad",
    });
    const messages = captureOutput();

    assert.throws(
      () => validateTweak(root, messages.output),
      new Error("tweak validation failed with 3 error(s)"),
    );
    assert.deepEqual(messages.error, [
      "error name: name is required and must be a non-empty string",
      "error id: id may only contain letters, numbers, dots, underscores, and dashes",
      "error githubRepo: githubRepo must use owner/repo format",
    ]);
    assert.deepEqual(messages.warn, [
      "warn version: version should be semver, for example 0.2.0",
      "warn scope: scope is omitted and defaults to both",
    ]);
    assert.deepEqual(messages.log, []);
  });
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-tweak-project-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeManifest(root: string, manifest: object): void {
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function captureOutput(): {
  output: TweakCommandOutput;
  log: string[];
  warn: string[];
  error: string[];
} {
  const log: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    output: {
      log: (message) => log.push(message),
      warn: (message) => warn.push(message),
      error: (message) => error.push(message),
    },
    log,
    warn,
    error,
  };
}

function withSourceCanonicalization<T>(
  sourceDir: string,
  beforeCanonicalization: () => void,
  run: () => T,
): T {
  const originalRealpathSync = fs.realpathSync;
  let intercepted = false;
  const replacement = ((...args: unknown[]) => {
    if (!intercepted && resolve(String(args[0])) === resolve(sourceDir)) {
      intercepted = true;
      beforeCanonicalization();
    }
    return Reflect.apply(originalRealpathSync, fs, args);
  }) as typeof fs.realpathSync;

  Reflect.set(fs, "realpathSync", replacement);
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    Reflect.set(fs, "realpathSync", originalRealpathSync);
    syncBuiltinESMExports();
  }
}
