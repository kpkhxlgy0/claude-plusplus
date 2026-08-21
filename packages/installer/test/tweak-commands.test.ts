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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { SettingsPage } from "@claude-plusplus/sdk";
import {
  createTweak,
  type CreatedTweakProject,
  type CreateTweakOptions,
} from "../src/commands/create-tweak.ts";
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
