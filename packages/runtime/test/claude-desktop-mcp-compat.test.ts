import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  installModuleObserver,
  type ClaudeDesktopMcpBindings,
  type ClaudeDesktopMcpProbeDiagnostic,
} from "../src/claude-desktop-mcp-compat.ts";

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

const moduleInternals = Module as unknown as { _load: ModuleLoad };
const requireFromTest = createRequire(join(process.cwd(), "package.json"));
const DESKTOP_VERSION = "1.26832.0";
const MODULES = {
  coordinator: {
    basename: "index.chunk-BaOfA05g.js",
    hash: "2ee867ed8d9a37bbd080e36fe70761a5c950ddf5f83eba34e3352e42da810b2b",
    source: `
      const coordinator = class {
        constructor() { this.sessionType = "ccd"; }
        async createAllServers() { return {}; }
      };
      module.exports = { et: coordinator, marker: "coordinator" };
    `,
  },
  sdk: {
    basename: "index.chunk-Cqfh0Vpp.js",
    hash: "770123370be8db84e4750a2b593d9a3a0b9ed447c62708f3bc306c9f2a05994c",
    source: `
      function createSdkMcpServer(options) {
        return { type: "sdk", name: options.name, instance: {} };
      }
      module.exports = { t: createSdkMcpServer, marker: "sdk" };
    `,
  },
  session: {
    basename: "index2.chunk-ZVJDHx_k.js",
    hash: "958cb9170271ab2f39db40b6ab0681a4e21e672327c51337800ba8c46221daba",
    source: `
      const sessionManager = {
        sessions: new Map(),
        getSession: async () => null,
        updateSession: async () => {},
        applyMcpServersIfIdle: async () => {},
      };
      module.exports = { claudeCodeSessionManager: sessionManager, marker: "session" };
    `,
  },
  schema: {
    basename: "index.chunk-CPsVP-Uv.js",
    hash: "d8f3af544b3bb00203422c2a541b1d73f91c1bd85cd7e3ada90e116fdab919f7",
    source: `
      function jsonSchemaToZodShape(schema) { return { schema }; }
      module.exports = { t: jsonSchemaToZodShape, marker: "schema" };
    `,
  },
} as const;

type ModuleRole = keyof typeof MODULES;
type LoadedModules = Record<ModuleRole, Record<string, unknown>>;

test("publishes bindings once for the exact Desktop version, hashes, and export shapes", () => {
  const fixture = createFixture();
  const originalLoad = moduleInternals._load;
  const received: ClaudeDesktopMcpBindings[] = [];
  const observer = installModuleObserver({
    desktopVersion: DESKTOP_VERSION,
    hashFile: literalHash,
    onBindings(bindings) {
      received.push(bindings);
    },
  });

  try {
    const loaded = fixture.loadAll();
    fixture.loadAll();

    assert.equal(observer.status, "supported");
    assert.equal(received.length, 1);
    assert.equal(observer.bindings, received[0]);
    assert.equal(received[0]?.coordinatorConstructor, loaded.coordinator.et);
    assert.equal(received[0]?.createSdkMcpServer, loaded.sdk.t);
    assert.equal(received[0]?.sessionManager, loaded.session.claudeCodeSessionManager);
    assert.equal(received[0]?.jsonSchemaToZodShape, loaded.schema.t);
    assert.equal(moduleInternals._load, originalLoad);
  } finally {
    observer.dispose();
    fixture.dispose();
    moduleInternals._load = originalLoad;
  }
});

test("rejects a different Desktop version without installing the loader wrapper", () => {
  const fixture = createFixture();
  const originalLoad = moduleInternals._load;
  const received: ClaudeDesktopMcpBindings[] = [];
  const observer = installModuleObserver({
    desktopVersion: "1.26832.1",
    hashFile: literalHash,
    onBindings(bindings) {
      received.push(bindings);
    },
  });

  try {
    fixture.loadAll();

    assert.equal(observer.status, "unsupported");
    assert.equal(observer.bindings, null);
    assert.deepEqual(received, []);
    assert.equal(moduleInternals._load, originalLoad);
  } finally {
    observer.dispose();
    fixture.dispose();
    moduleInternals._load = originalLoad;
  }
});

test("rejects every expected module when its hash differs and restores the loader", async (t) => {
  for (const role of Object.keys(MODULES) as ModuleRole[]) {
    await t.test(role, () => {
      const fixture = createFixture();
      const originalLoad = moduleInternals._load;
      const received: ClaudeDesktopMcpBindings[] = [];
      const observer = installModuleObserver({
        desktopVersion: DESKTOP_VERSION,
        hashFile(filename) {
          return basename(filename) === MODULES[role].basename ? "0".repeat(64) : literalHash(filename);
        },
        onBindings(bindings) {
          received.push(bindings);
        },
      });

      try {
        const loaded = fixture.load(role);

        assert.equal(loaded.marker, role);
        assert.equal(observer.status, "unsupported");
        assert.equal(observer.bindings, null);
        assert.deepEqual(received, []);
        assert.equal(moduleInternals._load, originalLoad);
      } finally {
        observer.dispose();
        fixture.dispose();
        moduleInternals._load = originalLoad;
      }
    });
  }
});

test("rejects every missing required export member and restores the loader", async (t) => {
  const missingMembers: Array<{ name: string; role: ModuleRole; source: string }> = [
    { name: "coordinator createAllServers", role: "coordinator", source: "module.exports = { et: class {} };" },
    { name: "SDK createSdkMcpServer", role: "sdk", source: "module.exports = {};" },
    { name: "schema converter", role: "schema", source: "module.exports = {};" },
    {
      name: "session sessions map",
      role: "session",
      source: sessionManagerSource("getSession", "updateSession", "applyMcpServersIfIdle"),
    },
    {
      name: "session getSession",
      role: "session",
      source: sessionManagerSource("sessions", "updateSession", "applyMcpServersIfIdle"),
    },
    {
      name: "session updateSession",
      role: "session",
      source: sessionManagerSource("sessions", "getSession", "applyMcpServersIfIdle"),
    },
    {
      name: "session applyMcpServersIfIdle",
      role: "session",
      source: sessionManagerSource("sessions", "getSession", "updateSession"),
    },
  ];

  for (const missing of missingMembers) {
    await t.test(missing.name, () => {
      const fixture = createFixture({ [missing.role]: missing.source });
      const originalLoad = moduleInternals._load;
      const observer = installModuleObserver({
        desktopVersion: DESKTOP_VERSION,
        hashFile: literalHash,
        onBindings() {
          assert.fail("unsupported module shape published bindings");
        },
      });

      try {
        fixture.load(missing.role);

        assert.equal(observer.status, "unsupported");
        assert.equal(observer.bindings, null);
        assert.equal(moduleInternals._load, originalLoad);
      } finally {
        observer.dispose();
        fixture.dispose();
        moduleInternals._load = originalLoad;
      }
    });
  }
});

test("a throwing bindings consumer cannot alter or block the original module export", () => {
  const expectedSchema = {
    marker: "schema",
    t(schema: Record<string, unknown>) {
      return { schema };
    },
  };
  const globalWithFixture = globalThis as typeof globalThis & {
    __claudePlusPlusSchemaFixture?: typeof expectedSchema;
  };
  globalWithFixture.__claudePlusPlusSchemaFixture = expectedSchema;
  const fixture = createFixture({
    schema: "module.exports = globalThis.__claudePlusPlusSchemaFixture;",
  });
  const originalLoad = moduleInternals._load;
  const observer = installModuleObserver({
    desktopVersion: DESKTOP_VERSION,
    hashFile: literalHash,
    onBindings() {
      throw new Error("consumer failed");
    },
  });

  try {
    const coordinator = fixture.load("coordinator");
    fixture.load("sdk");
    fixture.load("session");
    const loadedSchema = fixture.load("schema");

    assert.equal(coordinator.marker, "coordinator");
    assert.equal(loadedSchema, expectedSchema);
    assert.equal(loadedSchema.marker, "schema");
    assert.equal(observer.status, "supported");
    assert.notEqual(observer.bindings, null);
    assert.equal(moduleInternals._load, originalLoad);
  } finally {
    observer.dispose();
    fixture.dispose();
    delete globalWithFixture.__claudePlusPlusSchemaFixture;
    moduleInternals._load = originalLoad;
  }
});

test("dispose restores the loader only while its own wrapper is installed", () => {
  const originalLoad = moduleInternals._load;
  const first = installModuleObserver({
    desktopVersion: DESKTOP_VERSION,
    hashFile: literalHash,
    onBindings() {},
  });
  assert.notEqual(moduleInternals._load, originalLoad);
  first.dispose();
  assert.equal(moduleInternals._load, originalLoad);

  const second = installModuleObserver({
    desktopVersion: DESKTOP_VERSION,
    hashFile: literalHash,
    onBindings() {},
  });
  const foreignWrapper: ModuleLoad = function (this: unknown, request, parent, isMain) {
    return Reflect.apply(originalLoad, this, [request, parent, isMain]) as unknown;
  };
  moduleInternals._load = foreignWrapper;

  try {
    second.dispose();
    assert.equal(moduleInternals._load, foreignWrapper);
  } finally {
    moduleInternals._load = originalLoad;
  }
});

test("diagnostics contain only version, basename, outcome, and error category", () => {
  const fixture = createFixture();
  const originalLoad = moduleInternals._load;
  const diagnostics: ClaudeDesktopMcpProbeDiagnostic[] = [];
  const observer = installModuleObserver({
    desktopVersion: DESKTOP_VERSION,
    hashFile() {
      return "0".repeat(64);
    },
    onBindings() {},
    log(diagnostic) {
      diagnostics.push(diagnostic);
    },
  });

  try {
    fixture.load("coordinator");

    assert.deepEqual(diagnostics, [{
      version: DESKTOP_VERSION,
      basename: MODULES.coordinator.basename,
      outcome: false,
      category: "hash",
    }]);
    assert.equal(JSON.stringify(diagnostics).includes(fixture.root), false);
  } finally {
    observer.dispose();
    fixture.dispose();
    moduleInternals._load = originalLoad;
  }
});

function literalHash(filename: string): string {
  const target = Object.values(MODULES).find((entry) => entry.basename === basename(filename));
  if (!target) throw new Error(`unexpected hash request for ${basename(filename)}`);
  return target.hash;
}

function sessionManagerSource(...members: string[]): string {
  const entries = members.map((member) => member === "sessions"
    ? "sessions: new Map()"
    : `${member}: async () => {}`).join(",\n");
  return `module.exports = { claudeCodeSessionManager: { ${entries} } };`;
}

function createFixture(overrides: Partial<Record<ModuleRole, string>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudepp-mcp-compat-"));
  const paths = {} as Record<ModuleRole, string>;
  for (const role of Object.keys(MODULES) as ModuleRole[]) {
    const directory = join(root, role);
    mkdirSync(directory);
    paths[role] = join(directory, MODULES[role].basename);
    writeFileSync(paths[role], overrides[role] ?? MODULES[role].source, "utf8");
  }

  const load = (role: ModuleRole): Record<string, unknown> => (
    requireFromTest(paths[role]) as Record<string, unknown>
  );
  return {
    root,
    load,
    loadAll(): LoadedModules {
      const loaded = {} as LoadedModules;
      for (const role of Object.keys(MODULES) as ModuleRole[]) loaded[role] = load(role);
      return loaded;
    },
    dispose(): void {
      for (const role of Object.keys(paths) as ModuleRole[]) {
        delete requireFromTest.cache[requireFromTest.resolve(paths[role])];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
