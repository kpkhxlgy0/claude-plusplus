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
type ModuleRole = "coordinator" | "sdk" | "session" | "schema";
type ModuleFixture = {
  basename: string;
  hash: string;
  exportSlot: string;
  source: string;
};
type BuildFixture = {
  version: string;
  modules: Record<ModuleRole, ModuleFixture>;
};
type LoadedModules = Record<ModuleRole, Record<string, unknown>>;

const moduleInternals = Module as unknown as { _load: ModuleLoad };
const requireFromTest = createRequire(join(process.cwd(), "package.json"));
const MODULE_ROLES: readonly ModuleRole[] = ["coordinator", "sdk", "session", "schema"];
const BUILDS = [
  {
    version: "1.26832.0",
    modules: {
      coordinator: {
        basename: "index.chunk-BaOfA05g.js",
        hash: "2ee867ed8d9a37bbd080e36fe70761a5c950ddf5f83eba34e3352e42da810b2b",
        exportSlot: "et",
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
        exportSlot: "t",
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
        exportSlot: "claudeCodeSessionManager",
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
        exportSlot: "t",
        source: `
          function jsonSchemaToZodShape(schema) { return { schema }; }
          module.exports = { t: jsonSchemaToZodShape, marker: "schema" };
        `,
      },
    },
  },
  {
    version: "1.32885.1",
    modules: {
      coordinator: {
        basename: "index2.chunk-CxKk9JLq.js",
        hash: "80811026e6adf46b5f6d8c9d95303908f34668cde1c7aa47b6404ac2a7d52ae3",
        exportSlot: "Ct",
        source: `
          const coordinator = class {
            constructor() { this.sessionType = "ccd"; }
            async createAllServers() { return {}; }
          };
          module.exports = { Ct: coordinator, marker: "coordinator" };
        `,
      },
      sdk: {
        basename: "index.chunk-mU2Ud8Q2.js",
        hash: "4599836d15846febabe6ba2d25ee5935d046b823174f4ce23ddb0670b54cf526",
        exportSlot: "o",
        source: `
          function createSdkMcpServer(options) {
            return { type: "sdk", name: options.name, instance: {} };
          }
          module.exports = { o: createSdkMcpServer, marker: "sdk" };
        `,
      },
      session: {
        basename: "index.chunk-DDK-8_aa.js",
        hash: "88635924c6c13ea2b18af186af877d86c720438c39f1fa0fac23cbc776329b68",
        exportSlot: "claudeCodeSessionManager",
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
        basename: "index2.chunk-BCdS6ADu.js",
        hash: "e2a496d092c2e328b186425660fbf36a39e36b3ecadb4d5c8a2fae0ae9ac0ec1",
        exportSlot: "t",
        source: `
          function jsonSchemaToZodShape(schema) { return { schema }; }
          module.exports = { t: jsonSchemaToZodShape, marker: "schema" };
        `,
      },
    },
  },
] as const satisfies readonly BuildFixture[];

test("publishes bindings once for every exact supported Desktop build", async (t) => {
  for (const build of BUILDS) {
    await t.test(build.version, () => {
      const fixture = createFixture(build);
      const originalLoad = moduleInternals._load;
      const received: ClaudeDesktopMcpBindings[] = [];
      const observer = installModuleObserver({
        desktopVersion: build.version,
        hashFile(filename) {
          return literalHash(build, filename);
        },
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
        assert.equal(
          received[0]?.coordinatorConstructor,
          loaded.coordinator[build.modules.coordinator.exportSlot],
        );
        assert.equal(received[0]?.createSdkMcpServer, loaded.sdk[build.modules.sdk.exportSlot]);
        assert.equal(received[0]?.sessionManager, loaded.session[build.modules.session.exportSlot]);
        assert.equal(received[0]?.jsonSchemaToZodShape, loaded.schema[build.modules.schema.exportSlot]);
        assert.equal(moduleInternals._load, originalLoad);
      } finally {
        observer.dispose();
        fixture.dispose();
        moduleInternals._load = originalLoad;
      }
    });
  }
});

test("1.32885.1 ignores the shaped Doi manager and binds the DDK Claude Code manager", () => {
  const build = BUILDS[1];
  const fixture = createFixture(build);
  const legacyRoot = mkdtempSync(join(tmpdir(), "claudepp-mcp-compat-legacy-session-"));
  const legacyPath = join(legacyRoot, "index2.chunk-Doi9IfNA.js");
  writeFileSync(legacyPath, `
    const sessionManager = {
      sessions: new Map(),
      getSession: async () => null,
      updateSession: async () => {},
      applyMcpServersIfIdle: async () => {},
    };
    module.exports = { n: sessionManager, marker: "legacy-session" };
  `, "utf8");
  const originalLoad = moduleInternals._load;
  const received: ClaudeDesktopMcpBindings[] = [];
  const observer = installModuleObserver({
    desktopVersion: build.version,
    hashFile(filename) {
      if (basename(filename) === basename(legacyPath)) {
        return "a7eaa600b023d2f7a589d0dd2437481b7ad8981ccea2b1f50101817cbbb584ff";
      }
      return literalHash(build, filename);
    },
    onBindings(bindings) {
      received.push(bindings);
    },
  });

  try {
    fixture.load("coordinator");
    fixture.load("sdk");
    fixture.load("schema");
    const legacySession = requireFromTest(legacyPath) as Record<string, unknown>;

    assert.equal(observer.status, "probing");
    assert.equal(observer.bindings, null);
    assert.deepEqual(received, []);

    const claudeCodeSession = fixture.load("session");

    assert.equal(observer.status, "supported");
    assert.equal(received.length, 1);
    assert.equal(
      received[0]?.sessionManager,
      claudeCodeSession[build.modules.session.exportSlot],
    );
    assert.notEqual(received[0]?.sessionManager, legacySession.n);
    assert.equal(moduleInternals._load, originalLoad);
  } finally {
    observer.dispose();
    fixture.dispose();
    delete requireFromTest.cache[requireFromTest.resolve(legacyPath)];
    rmSync(legacyRoot, { recursive: true, force: true });
    moduleInternals._load = originalLoad;
  }
});

test("rejects an unsupported Desktop version without installing the loader wrapper", () => {
  const build = BUILDS[0];
  const fixture = createFixture(build);
  const originalLoad = moduleInternals._load;
  const received: ClaudeDesktopMcpBindings[] = [];
  const observer = installModuleObserver({
    desktopVersion: "1.26832.1",
    hashFile(filename) {
      return literalHash(build, filename);
    },
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

test("does not normalize the current MSIX version to the supported app version", () => {
  const build = BUILDS[1];
  const fixture = createFixture(build);
  const originalLoad = moduleInternals._load;
  const observer = installModuleObserver({
    desktopVersion: "1.32885.1.0",
    hashFile(filename) {
      return literalHash(build, filename);
    },
    onBindings() {
      assert.fail("normalized MSIX version published bindings");
    },
  });

  try {
    fixture.loadAll();

    assert.equal(observer.status, "unsupported");
    assert.equal(observer.bindings, null);
    assert.equal(moduleInternals._load, originalLoad);
  } finally {
    observer.dispose();
    fixture.dispose();
    moduleInternals._load = originalLoad;
  }
});

test("rejects every expected module when its hash differs and restores the loader", async (t) => {
  for (const build of BUILDS) {
    for (const role of MODULE_ROLES) {
      await t.test(`${build.version} ${role}`, () => {
        const fixture = createFixture(build);
        const originalLoad = moduleInternals._load;
        const received: ClaudeDesktopMcpBindings[] = [];
        const observer = installModuleObserver({
          desktopVersion: build.version,
          hashFile(filename) {
            return basename(filename) === build.modules[role].basename
              ? "0".repeat(64)
              : literalHash(build, filename);
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
  }
});

test("rejects every missing required export member and restores the loader", async (t) => {
  for (const build of BUILDS) {
    const missingMembers: Array<{ name: string; role: ModuleRole; source: string }> = [
      {
        name: "coordinator createAllServers",
        role: "coordinator",
        source: `module.exports = { ${build.modules.coordinator.exportSlot}: class {} };`,
      },
      { name: "SDK createSdkMcpServer", role: "sdk", source: "module.exports = {};" },
      { name: "schema converter", role: "schema", source: "module.exports = {};" },
      {
        name: "session sessions map",
        role: "session",
        source: sessionManagerSource(build, "getSession", "updateSession", "applyMcpServersIfIdle"),
      },
      {
        name: "session getSession",
        role: "session",
        source: sessionManagerSource(build, "sessions", "updateSession", "applyMcpServersIfIdle"),
      },
      {
        name: "session updateSession",
        role: "session",
        source: sessionManagerSource(build, "sessions", "getSession", "applyMcpServersIfIdle"),
      },
      {
        name: "session applyMcpServersIfIdle",
        role: "session",
        source: sessionManagerSource(build, "sessions", "getSession", "updateSession"),
      },
    ];

    for (const missing of missingMembers) {
      await t.test(`${build.version} ${missing.name}`, () => {
        const fixture = createFixture(build, { [missing.role]: missing.source });
        const originalLoad = moduleInternals._load;
        const observer = installModuleObserver({
          desktopVersion: build.version,
          hashFile(filename) {
            return literalHash(build, filename);
          },
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
  }
});

test("a throwing bindings consumer cannot alter or block the original module export", async (t) => {
  for (const build of BUILDS) {
    await t.test(build.version, () => {
      const converter = (schema: Record<string, unknown>) => ({ schema });
      const expectedSchema: Record<string, unknown> = {
        marker: "schema",
        [build.modules.schema.exportSlot]: converter,
      };
      const globalWithFixture = globalThis as typeof globalThis & {
        __claudePlusPlusSchemaFixture?: Record<string, unknown>;
      };
      globalWithFixture.__claudePlusPlusSchemaFixture = expectedSchema;
      const fixture = createFixture(build, {
        schema: "module.exports = globalThis.__claudePlusPlusSchemaFixture;",
      });
      const originalLoad = moduleInternals._load;
      const observer = installModuleObserver({
        desktopVersion: build.version,
        hashFile(filename) {
          return literalHash(build, filename);
        },
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
  }
});

test("dispose restores the loader only while its own wrapper is installed", async (t) => {
  for (const build of BUILDS) {
    await t.test(build.version, () => {
      const originalLoad = moduleInternals._load;
      const first = installModuleObserver({
        desktopVersion: build.version,
        hashFile(filename) {
          return literalHash(build, filename);
        },
        onBindings() {},
      });
      assert.notEqual(moduleInternals._load, originalLoad);
      first.dispose();
      assert.equal(moduleInternals._load, originalLoad);

      const second = installModuleObserver({
        desktopVersion: build.version,
        hashFile(filename) {
          return literalHash(build, filename);
        },
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
  }
});

test("diagnostics contain only version, basename, outcome, and error category", async (t) => {
  for (const build of BUILDS) {
    await t.test(build.version, () => {
      const fixture = createFixture(build);
      const originalLoad = moduleInternals._load;
      const diagnostics: ClaudeDesktopMcpProbeDiagnostic[] = [];
      const observer = installModuleObserver({
        desktopVersion: build.version,
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
          version: build.version,
          basename: build.modules.coordinator.basename,
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
  }
});

function literalHash(build: BuildFixture, filename: string): string {
  const target = Object.values(build.modules).find((entry) => entry.basename === basename(filename));
  if (!target) throw new Error(`unexpected hash request for ${basename(filename)}`);
  return target.hash;
}

function sessionManagerSource(build: BuildFixture, ...members: string[]): string {
  const entries = members.map((member) => member === "sessions"
    ? "sessions: new Map()"
    : `${member}: async () => {}`).join(",\n");
  return `module.exports = { ${build.modules.session.exportSlot}: { ${entries} } };`;
}

function createFixture(
  build: BuildFixture,
  overrides: Partial<Record<ModuleRole, string>> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "claudepp-mcp-compat-"));
  const paths = {} as Record<ModuleRole, string>;
  for (const role of MODULE_ROLES) {
    const directory = join(root, role);
    mkdirSync(directory);
    paths[role] = join(directory, build.modules[role].basename);
    writeFileSync(paths[role], overrides[role] ?? build.modules[role].source, "utf8");
  }

  const load = (role: ModuleRole): Record<string, unknown> => (
    requireFromTest(paths[role]) as Record<string, unknown>
  );
  return {
    root,
    load,
    loadAll(): LoadedModules {
      const loaded = {} as LoadedModules;
      for (const role of MODULE_ROLES) loaded[role] = load(role);
      return loaded;
    },
    dispose(): void {
      for (const role of MODULE_ROLES) {
        delete requireFromTest.cache[requireFromTest.resolve(paths[role])];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
