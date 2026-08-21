import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import type { SettingsPage } from "@claude-plusplus/sdk";
import {
  createTweak,
  type CreatedTweakProject,
  type CreateTweakOptions,
} from "../src/commands/create-tweak.ts";
import { resolveClaudePlusPlusPaths, type ClaudePlusPlusPaths } from "../src/paths.ts";
import {
  ensureDevTweakLink,
  prepareDevTweak,
  unlinkDevTweakLink,
  writeDevReloadMarker,
} from "../src/tweak-dev-link.ts";
import { requireValidTweakProject } from "../src/tweak-project.ts";
import type { TweakCommandOutput } from "../src/tweak-output.ts";
import { tweakChannel } from "../../runtime/src/tweak-ipc.ts";

const projectRequire = createRequire(import.meta.url);
const expectedFiles = ["README.md", "index.js", "manifest.json", "package.json"];
const silentOutput: TweakCommandOutput = { log() {}, warn() {}, error() {} };

interface GeneratedTweak {
  start(api: unknown): unknown;
  stop(): unknown;
}

const scopeCases = [
  {
    scope: "renderer",
    slug: "my-renderer-tweak",
    name: "My Renderer Tweak",
    permissions: ["settings"],
  },
  {
    scope: "main",
    slug: "my-main-tweak",
    name: "My Main Tweak",
    permissions: ["ipc"],
  },
  {
    scope: "both",
    slug: "my-both-tweak",
    name: "My Both Tweak",
    permissions: ["settings", "ipc"],
  },
] as const;

for (const { scope, slug, name, permissions } of scopeCases) {
  test(`create scaffolds ${scope} with the exact manifest and only used permissions`, () => {
    withTempDir((root) => {
      const target = join(root, slug);

      const created = createTweak(target, { scope }, silentOutput);

      const expectedManifest = {
        id: `com.example.${slug}`,
        name,
        version: "0.1.0",
        githubRepo: `example/${slug}`,
        description: "A Claude++ Tweak.",
        scope,
        main: "index.js",
        permissions,
      };
      assert.deepEqual(readJson(join(target, "manifest.json")), expectedManifest);
      assert.deepEqual(created, {
        directory: resolve(target),
        manifest: expectedManifest,
      });
      assert.deepEqual(readdirSync(target).sort(), expectedFiles);

      const inspected = requireValidTweakProject(target);
      assert.deepEqual(inspected.manifest, expectedManifest);
      assert.equal(inspected.entryPath, join(target, "index.js"));
    });
  });
}

test("create applies every explicit metadata and scope override", () => {
  withTempDir((root) => {
    const target = join(root, "directory-name-is-not-metadata");
    const messages: string[] = [];

    const created = createValidTweak(target, {
      id: "com.acme.explicit",
      name: "Explicit Tweak",
      repo: "acme/explicit-tweak",
      scope: "main",
    }, outputInto(messages));

    const expectedManifest = {
      id: "com.acme.explicit",
      name: "Explicit Tweak",
      version: "0.1.0",
      githubRepo: "acme/explicit-tweak",
      description: "A Claude++ Tweak.",
      scope: "main",
      main: "index.js",
      permissions: ["ipc"],
    };
    assert.deepEqual(readJson(join(target, "manifest.json")), expectedManifest);
    assert.deepEqual(created.manifest, expectedManifest);
    assert.deepEqual(messages, [
      "✓ Created Claude++ Tweak",
      `  Directory: ${resolve(target)}`,
      `  Manifest:  ${resolve(target, "manifest.json")}`,
      "",
      "Next:",
      `  1. Edit ${resolve(target, "manifest.json")}`,
      `  2. Run claudeplusplus validate-tweak ${resolve(target)}`,
      `  3. Run claudeplusplus dev ${resolve(target)}`,
    ]);
  });
});

test("create writes an exact private dependency-free CommonJS package", () => {
  withTempDir((root) => {
    const target = join(root, "package-shape");
    createValidTweak(target);

    assert.deepEqual(readJson(join(target, "package.json")), {
      name: "package-shape",
      version: "0.1.0",
      private: true,
      type: "commonjs",
      scripts: {
        validate: "claudeplusplus validate-tweak .",
        dev: "claudeplusplus dev .",
      },
    });
  });
});

test("create writes the complete project README guidance", () => {
  withTempDir((root) => {
    const target = join(root, "readme-tweak");
    createValidTweak(target);

    assert.equal(readFileSync(join(target, "README.md"), "utf8"), `# Readme Tweak

A Claude++ Tweak.

## Project files

- \`manifest.json\` declares the Tweak metadata, process scope, and permissions.
- \`index.js\` exports the runnable CommonJS \`start(api)\` and \`stop()\` lifecycle.
- \`package.json\` provides the validation and development commands.
- \`README.md\` is this guide.

## Validate

\`\`\`sh
npm run validate
\`\`\`

## Develop

\`\`\`sh
npm run dev
npm run dev -- --no-watch
\`\`\`

Development links this project into \`%APPDATA%\\claude-plusplus\\tweaks\`, the live Tweak destination.

Release listeners, timers, Settings handles, and other resources in \`stop()\`. If Renderer changes do not apply to an existing Claude Session, restart Claude.
`);
  });
});

test("generated sources use only the approved CommonJS and Claude++ surfaces", () => {
  withTempDir((root) => {
    const sources = new Map<string, string>();
    for (const { scope } of scopeCases) {
      const target = join(root, scope);
      createValidTweak(target, { scope });
      sources.set(scope, readFileSync(join(target, "index.js"), "utf8"));
    }

    const renderer = sources.get("renderer")!;
    assert.match(renderer, /api\.settings\.registerPage/);
    assert.match(renderer, /settingsHandle\s*=\s*api\.settings\.registerPage/);
    assert.match(renderer, /settingsHandle\?\.unregister\(\)/);

    const main = sources.get("main")!;
    assert.match(main, /typeof api\.ipc\.handle !== "function"/);
    assert.match(main, /api\.ipc\.handle\("ping"/);
    assert.doesNotMatch(main, /\bdocument\b|\bwindow\b|\bHTMLElement\b/);

    const both = sources.get("both")!;
    assert.match(both, /api\.process === "main"/);
    assert.match(both, /api\.process === "renderer"/);
    assert.match(both, /api\.ipc\.handle\("ping"/);
    assert.match(both, /api\.ipc\.invoke\("ping"/);
    assert.match(both, /settingsHandle\?\.unregister\(\)/);

    for (const [scope, source] of sources) {
      assert.doesNotMatch(source, /\brequire\s*\(/, `${scope} require`);
      assert.doesNotMatch(source, /\bimport\s/, `${scope} import`);
      assert.doesNotMatch(source, /\bReact\b|\bOwl\b/, `${scope} UI framework`);
      assert.doesNotMatch(
        source,
        /api\.(?:native|browser|window|view|cdp|mcp)\b|mcpServers|externalMcp/i,
        `${scope} unsupported surface`,
      );
    }
  });
});

test("generated Renderer CommonJS runs and unregisters its Settings handle", () => {
  withTempDir((root) => {
    const target = join(root, "renderer-runtime");
    const created = createValidTweak(target, { scope: "renderer" });
    const tweak = loadFreshTweak(join(target, "index.js"));
    let page: SettingsPage | undefined;
    let unregisterCount = 0;
    const settings = strictObject("settings", {
      registerPage(candidate: SettingsPage) {
        page = candidate;
        return strictObject("settingsHandle", {
          unregister() {
            unregisterCount += 1;
          },
        });
      },
    });
    const api = strictObject("rendererApi", {
      manifest: created.manifest,
      settings,
    });

    tweak.start(api);

    assert.equal(page?.id, "main");
    assert.equal(page?.title, "Renderer Runtime");
    const rootElement = { textContent: "" };
    page?.render(rootElement as HTMLElement);
    assert.equal(rootElement.textContent, "Renderer Tweak loaded.");
    tweak.stop();
    assert.equal(unregisterCount, 1);
  });
});

test("generated Main CommonJS handles the local ping channel and has a safe stop", () => {
  withTempDir((root) => {
    const target = join(root, "main-runtime");
    const created = createValidTweak(target, { scope: "main" });
    const tweak = loadFreshTweak(join(target, "index.js"));
    let handler: ((...args: unknown[]) => unknown) | undefined;
    const messages: string[] = [];
    const api = strictObject("mainApi", {
      manifest: created.manifest,
      log: strictObject("log", { info: (message: string) => messages.push(message) }),
      ipc: strictObject("ipc", {
        handle(channel: string, candidate: (...args: unknown[]) => unknown) {
          assertLocalPing(created.manifest.id, channel);
          handler = candidate;
        },
      }),
    });

    tweak.start(api);

    assert.equal(handler?.(), "pong from main");
    assert.deepEqual(messages, ["Main Tweak started."]);
    assert.doesNotThrow(() => tweak.stop());
  });
});

test("generated both-process CommonJS runs fresh Main and Renderer instances", async () => {
  await withTempDirAsync(async (root) => {
    const target = join(root, "both-runtime");
    const created = createValidTweak(target, { scope: "both" });
    const entry = join(target, "index.js");
    let handler: ((...args: unknown[]) => unknown) | undefined;
    const mainTweak = loadFreshTweak(entry);
    const mainApi = strictObject("mainApi", {
      process: "main",
      log: strictObject("log", { info() {} }),
      ipc: strictObject("ipc", {
        handle(channel: string, candidate: (...args: unknown[]) => unknown) {
          assertLocalPing(created.manifest.id, channel);
          handler = candidate;
        },
      }),
    });

    mainTweak.start(mainApi);
    assert.equal(handler?.(), "pong from main");
    assert.doesNotThrow(() => mainTweak.stop());

    let page: SettingsPage | undefined;
    let unregisterCount = 0;
    const invoked: string[] = [];
    const rendererTweak = loadFreshTweak(entry);
    assert.notEqual(rendererTweak, mainTweak);
    const rendererApi = strictObject("rendererApi", {
      process: "renderer",
      manifest: created.manifest,
      settings: strictObject("settings", {
        registerPage(candidate: SettingsPage) {
          page = candidate;
          return strictObject("settingsHandle", {
            unregister() {
              unregisterCount += 1;
            },
          });
        },
      }),
      ipc: strictObject("ipc", {
        async invoke(channel: string) {
          assertLocalPing(created.manifest.id, channel);
          invoked.push(channel);
          return "pong from main";
        },
      }),
    });

    rendererTweak.start(rendererApi);
    assert.equal(page?.id, "main");
    assert.equal(page?.title, "Both Runtime");
    const dom = fakeDom();
    page?.render(dom.root as unknown as HTMLElement);
    const button = dom.created.find((element) => element.tagName === "button");
    const output = dom.created.find((element) => element.tagName === "p");
    assert.ok(button?.onclick);
    await button.onclick();
    assert.deepEqual(invoked, ["ping"]);
    assert.equal(output?.textContent, "pong from main");
    rendererTweak.stop();
    assert.equal(unregisterCount, 1);
  });
});

test("create refuses an existing file without changing it", () => {
  withTempDir((root) => {
    const target = join(root, "existing-file");
    writeFileSync(target, "keep", "utf8");

    assert.throws(
      () => createTweak(target, { force: true }, silentOutput),
      /target already exists and is not a directory/,
    );
    assert.equal(readFileSync(target, "utf8"), "keep");
  });
});

test("create refuses a non-empty directory even when force is true", () => {
  withTempDir((root) => {
    const target = join(root, "non-empty");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep", "utf8");

    assert.throws(
      () => createTweak(target, { force: true }, silentOutput),
      /target already exists and is not empty/,
    );
    assert.deepEqual(readdirSync(target), ["keep.txt"]);
  });
});

test("create refuses an empty directory without force", () => {
  withTempDir((root) => {
    const target = join(root, "empty-no-force");
    mkdirSync(target);

    assert.throws(
      () => createTweak(target, {}, silentOutput),
      /target already exists; use --force/,
    );
    assert.deepEqual(readdirSync(target), []);
  });
});

test("create scaffolds an existing empty directory with force", () => {
  withTempDir((root) => {
    const target = join(root, "empty-forced");
    mkdirSync(target);

    createValidTweak(target, { force: true });

    assert.deepEqual(readdirSync(target).sort(), expectedFiles);
    assert.equal(requireValidTweakProject(target).manifest.id, "com.example.empty-forced");
  });
});

test("invalid generated metadata creates no target directory", () => {
  withTempDir((root) => {
    const target = join(root, "invalid-output");

    assert.throws(
      () => createTweak(target, { id: "invalid id" }, silentOutput),
      /id:/,
    );
    assert.equal(existsSync(target), false);
  });
});

test("invalid generated metadata leaves a forced empty target untouched", () => {
  withTempDir((root) => {
    const target = join(root, "invalid-existing-output");
    mkdirSync(target);

    assert.throws(
      () => createTweak(target, { id: "invalid id", force: true }, silentOutput),
      /id:/,
    );
    assert.deepEqual(readdirSync(target), []);
  });
});

test("create requires a target directory argument", () => {
  assert.throws(
    () => createTweak("", {}, silentOutput),
    new Error("target directory is required"),
  );
});

test("dev preparation creates an immediate-child Junction and root marker", async () => {
  await withDevFixture(async ({ source, paths }) => {
    assert.equal(existsSync(paths.tweaks), false);

    const result = prepareDevTweak(source, {}, {
      paths,
      now: () => 123,
      output: silentOutput,
    });

    const link = join(paths.tweaks, "com.example.dev");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(result.sourceDir, resolve(source));
    assert.equal(result.linkPath, link);
    assert.equal(result.markerPath, join(paths.tweaks, ".claudepp-dev-reload"));
    assert.equal(result.manifest.id, "com.example.dev");
    assert.equal(result.linkStatus, "created");
    assert.equal(readFileSync(result.markerPath, "utf8"), "123");
    assert.equal(existsSync(join(source, ".claudepp-dev-reload")), false);
  });
});

test("dev preparation keeps a current Junction and refreshes the root marker", async () => {
  await withDevFixture(async ({ source, paths }) => {
    const created = prepareDevTweak(source, {}, {
      paths,
      now: () => 100,
      output: silentOutput,
    });
    const current = prepareDevTweak(source, {}, {
      paths,
      now: () => 200,
      output: silentOutput,
    });

    assert.equal(created.linkStatus, "created");
    assert.equal(current.linkStatus, "current");
    assert.equal(lstatSync(current.linkPath).isSymbolicLink(), true);
    assert.equal(realpathSync(current.linkPath).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(readFileSync(current.markerPath, "utf8"), "200");
    assert.equal(lstatSync(current.markerPath).isFile(), true);
    assert.equal(lstatSync(current.markerPath).nlink, 1);
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev preparation refuses a wrong-source Junction unless replacement is requested", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const other = join(root, "other-source-project");
    createTweak(other, {
      id: "com.example.dev",
      name: "Other Dev",
      repo: "example/other-dev",
      scope: "both",
    }, silentOutput);
    const first = prepareDevTweak(source, {}, {
      paths,
      now: () => 100,
      output: silentOutput,
    });

    assert.throws(
      () => prepareDevTweak(other, {}, {
        paths,
        now: () => 200,
        output: silentOutput,
      }),
      /already exists/,
    );
    assert.equal(realpathSync(first.linkPath).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(readFileSync(first.markerPath, "utf8"), "100");

    const replaced = prepareDevTweak(other, { replace: true }, {
      paths,
      now: () => 300,
      output: silentOutput,
    });
    assert.equal(replaced.linkStatus, "replaced");
    assert.equal(realpathSync(replaced.linkPath).toLowerCase(), realpathSync(other).toLowerCase());
    assert.equal(readFileSync(replaced.markerPath, "utf8"), "300");
    assert.equal(existsSync(join(source, "index.js")), true);
    assert.equal(existsSync(join(other, "index.js")), true);
  });
});

test("dev preparation never replaces a real file", async () => {
  await withDevFixture(async ({ source, paths }) => {
    mkdirSync(paths.tweaks, { recursive: true });
    const link = join(paths.tweaks, "com.example.dev");
    writeFileSync(link, "keep", "utf8");

    assert.throws(
      () => prepareDevTweak(source, { replace: true }, { paths, output: silentOutput }),
      /not a symbolic link/,
    );
    assert.equal(readFileSync(link, "utf8"), "keep");
    assert.equal(existsSync(join(paths.tweaks, ".claudepp-dev-reload")), false);
  });
});

test("dev preparation never replaces a real directory", async () => {
  await withDevFixture(async ({ source, paths }) => {
    const link = join(paths.tweaks, "com.example.dev");
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "keep.txt"), "keep", "utf8");

    assert.throws(
      () => prepareDevTweak(source, { replace: true }, { paths, output: silentOutput }),
      /not a symbolic link/,
    );
    assert.equal(readFileSync(join(link, "keep.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(paths.tweaks, ".claudepp-dev-reload")), false);
  });
});

test("dev preparation rejects and retains a dangling Junction", async (context) => {
  await withDevFixture(async ({ root, source, paths }) => {
    mkdirSync(paths.tweaks, { recursive: true });
    const link = join(paths.tweaks, "com.example.dev");
    try {
      symlinkSync(join(root, "missing-junction-target"), link, "junction");
    } catch (error) {
      context.skip(`Windows could not create a dangling Junction: ${String(error)}`);
      return;
    }
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(link), false);

    assert.throws(
      () => prepareDevTweak(source, { replace: true }, { paths, output: silentOutput }),
      /broken/,
    );
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(join(paths.tweaks, ".claudepp-dev-reload")), false);
  });
});

test("dev preparation rejects an invalid source before creating the Tweaks root", async () => {
  await withDevFixture(async ({ source, paths }) => {
    rmSync(join(source, "index.js"));

    assert.throws(
      () => prepareDevTweak(source, {}, { paths, output: silentOutput }),
      /entry file does not exist/,
    );
    assert.equal(existsSync(paths.tweaks), false);
  });
});

test("dev preparation requires a source directory before creating the Tweaks root", async () => {
  await withDevFixture(async ({ source, paths }) => {
    assert.throws(
      () => prepareDevTweak(join(source, "manifest.json"), {}, {
        paths,
        output: silentOutput,
      }),
      /source must be a directory/,
    );
    assert.equal(existsSync(paths.tweaks), false);
  });
});

test("dev preparation rejects unsupported platforms before source validation or root creation", async () => {
  await withDevFixture(async ({ root, paths }) => {
    assert.throws(
      () => prepareDevTweak(join(root, "missing-source"), {}, {
        paths,
        output: silentOutput,
        platform: () => "linux",
      }),
      /Tweak development links require Windows/,
    );
    assert.equal(existsSync(paths.tweaks), false);
  });
});

for (const name of ["", ".", "..", "a/b", "a\\b", "C:escape", "bad name"]) {
  test(`dev preparation rejects the unsafe link name ${JSON.stringify(name)} without mutation`, async () => {
    await withDevFixture(async ({ root, source, paths }) => {
      const before = snapshotTree(root);

      assert.throws(
        () => prepareDevTweak(source, { name }, { paths, output: silentOutput }),
        /Tweak link name may contain only/,
      );
      assert.equal(existsSync(paths.tweaks), false);
      assert.deepEqual(snapshotTree(root), before);
    });
  });
}

for (const name of [".claudepp-dev-reload", ".CLAUDEPP-DEV-RELOAD"]) {
  test(`dev preparation reserves the explicit reload marker name ${name} without mutation`, async () => {
    await withDevFixture(async ({ root, source, paths }) => {
      const before = snapshotTree(root);

      assert.throws(
        () => prepareDevTweak(source, { name }, { paths, output: silentOutput }),
        /reserved reload marker/,
      );
      assert.equal(existsSync(paths.tweaks), false);
      assert.deepEqual(snapshotTree(root), before);
    });
  });
}

for (const id of [".claudepp-dev-reload", ".ClAuDePp-DeV-ReLoAd"]) {
  test(`dev preparation reserves the default reload marker manifest id ${id} without mutation`, async () => {
    await withDevFixture(async ({ root, source, paths }) => {
      replaceManifestId(source, id);
      const before = snapshotTree(root);

      assert.throws(
        () => prepareDevTweak(source, {}, { paths, output: silentOutput }),
        /reserved reload marker/,
      );
      assert.equal(existsSync(paths.tweaks), false);
      assert.deepEqual(snapshotTree(root), before);
    });
  });
}

test("dev preparation rejects a marker file symlink before changing the current link", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const { link, marker, other } = createMarkerCollisionFixture(root, source, paths);
    const sourceEntry = join(source, "index.js");
    const originalEntry = readFileSync(sourceEntry, "utf8");
    unlinkSync(marker);
    symlinkSync(sourceEntry, marker, "file");

    assert.throws(
      () => prepareDevTweak(other, { replace: true }, { paths, output: silentOutput }),
      /reload marker.*regular file/i,
    );
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(lstatSync(marker).isSymbolicLink(), true);
    assert.equal(readFileSync(sourceEntry, "utf8"), originalEntry);
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev preparation rejects a hard-linked marker before changing the current link", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const { link, marker, other } = createMarkerCollisionFixture(root, source, paths);
    const external = join(root, "external-marker.txt");
    writeFileSync(external, "keep", "utf8");
    unlinkSync(marker);
    linkSync(external, marker);

    assert.throws(
      () => prepareDevTweak(other, { replace: true }, { paths, output: silentOutput }),
      /reload marker.*single-link regular file/i,
    );
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(lstatSync(marker).nlink, 2);
    assert.equal(readFileSync(external, "utf8"), "keep");
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev preparation rejects a marker Junction before changing the current link", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const { link, marker, other } = createMarkerCollisionFixture(root, source, paths);
    const external = join(root, "external-marker-directory");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "keep", "utf8");
    unlinkSync(marker);
    symlinkSync(external, marker, "junction");

    assert.throws(
      () => prepareDevTweak(other, { replace: true }, { paths, output: silentOutput }),
      /reload marker.*regular file/i,
    );
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(realpathSync(marker).toLowerCase(), realpathSync(external).toLowerCase());
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "keep");
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev preparation rejects a marker directory before changing the current link", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const { link, marker, other } = createMarkerCollisionFixture(root, source, paths);
    unlinkSync(marker);
    mkdirSync(marker);
    writeFileSync(join(marker, "keep.txt"), "keep", "utf8");

    assert.throws(
      () => prepareDevTweak(other, { replace: true }, { paths, output: silentOutput }),
      /reload marker.*regular file/i,
    );
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(source).toLowerCase());
    assert.equal(readFileSync(join(marker, "keep.txt"), "utf8"), "keep");
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev marker atomic replacement never writes through a post-preflight symlink", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const prepared = prepareDevTweak(source, {}, {
      paths,
      now: () => 100,
      output: silentOutput,
    });
    const external = join(root, "post-preflight-target.txt");
    writeFileSync(external, "keep", "utf8");
    let renameArguments: [string, string] | undefined;

    writeDevReloadMarker(paths, () => 200, {
      rename(tempPath, markerPath) {
        renameArguments = [tempPath, markerPath];
        unlinkSync(markerPath);
        symlinkSync(external, markerPath, "file");
        renameSync(tempPath, markerPath);
      },
    });

    assert.ok(renameArguments);
    assert.equal(dirname(renameArguments[0]), paths.tweaks);
    assert.equal(renameArguments[1], prepared.markerPath);
    assert.equal(readFileSync(external, "utf8"), "keep");
    assert.equal(lstatSync(prepared.markerPath).isFile(), true);
    assert.equal(lstatSync(prepared.markerPath).isSymbolicLink(), false);
    assert.equal(readFileSync(prepared.markerPath, "utf8"), "200");
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev marker cleans its exclusive temporary file when atomic replacement fails", async () => {
  await withDevFixture(async ({ source, paths }) => {
    const prepared = prepareDevTweak(source, {}, {
      paths,
      now: () => 100,
      output: silentOutput,
    });

    assert.throws(
      () => writeDevReloadMarker(paths, () => 200, {
        rename() {
          throw new Error("injected rename failure");
        },
      }),
      /injected rename failure/,
    );
    assert.equal(readFileSync(prepared.markerPath, "utf8"), "100");
    assert.deepEqual(devMarkerTempNames(paths), []);
  });
});

test("dev link containment refuses the Tweaks root and preserves a sibling Junction", async () => {
  await withDevFixture(async ({ root, source, paths }) => {
    const other = join(root, "other-contained-source");
    createTweak(other, {
      id: "com.example.other",
      name: "Other",
      repo: "example/other",
      scope: "both",
    }, silentOutput);
    const sibling = join(dirname(paths.tweaks), "outside-tweaks");
    mkdirSync(dirname(sibling), { recursive: true });
    symlinkSync(realpathSync(other), sibling, "junction");

    assert.throws(
      () => ensureDevTweakLink(source, sibling, paths, true),
      /immediate child/,
    );
    assert.equal(lstatSync(sibling).isSymbolicLink(), true);
    assert.equal(realpathSync(sibling).toLowerCase(), realpathSync(other).toLowerCase());
    assert.throws(
      () => ensureDevTweakLink(source, paths.tweaks, paths, true),
      /immediate child/,
    );
    assert.equal(existsSync(paths.tweaks), false);
  });
});

test("dev link unlink removes only a Junction entry and fails closed for directories or absence", async () => {
  await withDevFixture(async ({ root, paths }) => {
    mkdirSync(paths.tweaks, { recursive: true });
    const target = join(root, "unlink-target");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep", "utf8");
    const junction = join(paths.tweaks, "junction");
    symlinkSync(target, junction, "junction");

    unlinkDevTweakLink(junction);

    assert.equal(lstatSync(junction, { throwIfNoEntry: false }), undefined);
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "keep");

    const emptyDirectory = join(paths.tweaks, "empty-directory");
    mkdirSync(emptyDirectory);
    assert.throws(() => unlinkDevTweakLink(emptyDirectory));
    assert.equal(lstatSync(emptyDirectory).isDirectory(), true);

    const nonEmptyDirectory = join(paths.tweaks, "non-empty-directory");
    mkdirSync(nonEmptyDirectory);
    writeFileSync(join(nonEmptyDirectory, "keep.txt"), "keep", "utf8");
    assert.throws(() => unlinkDevTweakLink(nonEmptyDirectory));
    assert.equal(readFileSync(join(nonEmptyDirectory, "keep.txt"), "utf8"), "keep");

    const absent = join(paths.tweaks, "absent");
    assert.throws(() => unlinkDevTweakLink(absent));
    assert.equal(lstatSync(absent, { throwIfNoEntry: false }), undefined);
  });
});

test("dev preparation reports every project warning and familiar link details", async () => {
  await withDevFixture(async ({ source, paths }) => {
    const manifestPath = join(source, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.scope;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const messages = captureTweakOutput();

    const result = prepareDevTweak(source, {}, {
      paths,
      output: messages.output,
    });

    assert.ok(messages.warn.some((message) => message.includes("scope")));
    assert.deepEqual(messages.log, [
      "✓ Claude++ dev link ready",
      `  Source: ${result.sourceDir}`,
      `  Linked: ${result.linkPath}`,
      `  Tweak:  ${result.manifest.id} (both)`,
    ]);
  });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function createValidTweak(
  target: string,
  options: CreateTweakOptions = {},
  output: TweakCommandOutput = silentOutput,
): CreatedTweakProject {
  const created = createTweak(target, options, output);
  const inspected = requireValidTweakProject(target);
  assert.deepEqual(inspected.manifest, created.manifest);
  assert.equal(inspected.entryPath, join(resolve(target), "index.js"));
  return created;
}

function loadFreshTweak(entry: string): GeneratedTweak {
  const resolvedEntry = projectRequire.resolve(entry);
  delete projectRequire.cache[resolvedEntry];
  const loaded = projectRequire(resolvedEntry) as Partial<GeneratedTweak>;
  assert.equal(typeof loaded.start, "function");
  assert.equal(typeof loaded.stop, "function");
  return loaded as GeneratedTweak;
}

function assertLocalPing(tweakId: string, channel: string): void {
  assert.equal(tweakChannel(tweakId, channel), `claudepp:${tweakId}:ping`);
  assert.equal(channel, "ping");
}

function strictObject<T extends object>(label: string, value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(`${label}.${String(property)} is not available`);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function fakeDom(): {
  root: object;
  created: Array<{
    tagName: string;
    textContent: string;
    onclick?: () => Promise<void>;
  }>;
} {
  const created: Array<{
    tagName: string;
    textContent: string;
    onclick?: () => Promise<void>;
  }> = [];
  const ownerDocument = strictObject("document", {
    createElement(tagName: string) {
      const element = { tagName, textContent: "" };
      created.push(element);
      return element;
    },
  });
  const appended: unknown[] = [];
  return {
    root: strictObject("root", {
      textContent: "",
      ownerDocument,
      append(...children: unknown[]) {
        appended.push(...children);
      },
    }),
    created,
  };
}

function outputInto(messages: string[]): TweakCommandOutput {
  return {
    log: (message) => messages.push(message),
    warn() {},
    error() {},
  };
}

function captureTweakOutput(): {
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

function replaceManifestId(source: string, id: string): void {
  const manifestPath = join(source, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.id = id;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function createMarkerCollisionFixture(
  root: string,
  source: string,
  paths: ClaudePlusPlusPaths,
): { link: string; marker: string; other: string } {
  const prepared = prepareDevTweak(source, {}, {
    paths,
    now: () => 100,
    output: silentOutput,
  });
  const other = join(root, "marker-collision-source");
  createTweak(other, {
    id: "com.example.dev",
    name: "Marker Collision",
    repo: "example/marker-collision",
    scope: "both",
  }, silentOutput);
  return { link: prepared.linkPath, marker: prepared.markerPath, other };
}

function devMarkerTempNames(paths: ClaudePlusPlusPaths): string[] {
  if (!existsSync(paths.tweaks)) return [];
  return readdirSync(paths.tweaks).filter((name) =>
    /^\.claudepp-dev-reload\..+\.tmp$/i.test(name)
  );
}

async function withDevFixture(
  run: (fixture: {
    root: string;
    source: string;
    paths: ClaudePlusPlusPaths;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "claudepp-dev-"));
  try {
    const source = join(root, "source-project");
    createTweak(source, {
      id: "com.example.dev",
      name: "Dev",
      repo: "example/dev",
      scope: "both",
    }, silentOutput);
    const paths = resolveClaudePlusPlusPaths({
      APPDATA: join(root, "profile", "appdata"),
      LOCALAPPDATA: join(root, "profile", "localappdata"),
      USERPROFILE: join(root, "profile"),
    });
    await run({ root, source, paths });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshotTree(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      paths.push(`${relative(root, path)}:${entry.isDirectory() ? "directory" : "file"}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
  return paths.sort();
}

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claudepp-create-tweak-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "claudepp-create-tweak-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
