import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { basename } from "node:path";

export interface SdkMcpServer {
  type: "sdk";
  name: string;
  instance: unknown;
}

export interface ClaudeDesktopSessionManager {
  sessions: Map<string, unknown>;
  getSession: (...args: unknown[]) => Promise<unknown>;
  updateSession: (...args: unknown[]) => Promise<unknown>;
  applyMcpServersIfIdle: (...args: unknown[]) => Promise<unknown>;
}

export interface ClaudeDesktopMcpBindings {
  coordinatorConstructor: {
    prototype: { createAllServers: (...args: unknown[]) => Promise<Record<string, unknown>> };
  };
  createSdkMcpServer(options: Record<string, unknown>): SdkMcpServer;
  jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, unknown>;
  sessionManager: ClaudeDesktopSessionManager;
}

export type ClaudeDesktopMcpProbeCategory =
  | "none"
  | "version"
  | "resolution"
  | "hash"
  | "shape"
  | "consumer";

export interface ClaudeDesktopMcpProbeDiagnostic {
  version: string;
  basename: string;
  outcome: boolean;
  category: ClaudeDesktopMcpProbeCategory;
}

export interface ClaudeDesktopMcpCompatibility {
  readonly status: "probing" | "supported" | "unsupported";
  readonly bindings: ClaudeDesktopMcpBindings | null;
  dispose(): void;
}

export interface InstallModuleObserverOptions {
  desktopVersion: string;
  onBindings(bindings: ClaudeDesktopMcpBindings): void;
  hashFile?: (filename: string) => string;
  log?: (diagnostic: ClaudeDesktopMcpProbeDiagnostic) => void;
}

type ModuleRole = "coordinator" | "sdk" | "session" | "schema";
type ExpectedModule = {
  basename: string;
  hash: string;
  exportSlot: string;
};
type CompatibilityRecord = Readonly<Record<ModuleRole, Readonly<ExpectedModule>>>;
type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
type ModuleInternals = typeof Module & {
  _load: ModuleLoad;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
type ObservedBindings = {
  coordinator?: ClaudeDesktopMcpBindings["coordinatorConstructor"];
  sdk?: ClaudeDesktopMcpBindings["createSdkMcpServer"];
  session?: ClaudeDesktopMcpBindings["sessionManager"];
  schema?: ClaudeDesktopMcpBindings["jsonSchemaToZodShape"];
};

const MODULE_ROLES: readonly ModuleRole[] = ["coordinator", "sdk", "session", "schema"];
const COMPATIBILITY_RECORDS: ReadonlyMap<string, CompatibilityRecord> = new Map<string, CompatibilityRecord>([
  ["1.26832.0", Object.freeze({
    coordinator: Object.freeze({
      basename: "index.chunk-BaOfA05g.js",
      hash: "2ee867ed8d9a37bbd080e36fe70761a5c950ddf5f83eba34e3352e42da810b2b",
      exportSlot: "et",
    }),
    sdk: Object.freeze({
      basename: "index.chunk-Cqfh0Vpp.js",
      hash: "770123370be8db84e4750a2b593d9a3a0b9ed447c62708f3bc306c9f2a05994c",
      exportSlot: "t",
    }),
    session: Object.freeze({
      basename: "index2.chunk-ZVJDHx_k.js",
      hash: "958cb9170271ab2f39db40b6ab0681a4e21e672327c51337800ba8c46221daba",
      exportSlot: "claudeCodeSessionManager",
    }),
    schema: Object.freeze({
      basename: "index.chunk-CPsVP-Uv.js",
      hash: "d8f3af544b3bb00203422c2a541b1d73f91c1bd85cd7e3ada90e116fdab919f7",
      exportSlot: "t",
    }),
  })],
  ["1.32885.1", Object.freeze({
    coordinator: Object.freeze({
      basename: "index2.chunk-CxKk9JLq.js",
      hash: "80811026e6adf46b5f6d8c9d95303908f34668cde1c7aa47b6404ac2a7d52ae3",
      exportSlot: "Ct",
    }),
    sdk: Object.freeze({
      basename: "index.chunk-mU2Ud8Q2.js",
      hash: "4599836d15846febabe6ba2d25ee5935d046b823174f4ce23ddb0670b54cf526",
      exportSlot: "o",
    }),
    session: Object.freeze({
      basename: "index2.chunk-Doi9IfNA.js",
      hash: "a7eaa600b023d2f7a589d0dd2437481b7ad8981ccea2b1f50101817cbbb584ff",
      exportSlot: "n",
    }),
    schema: Object.freeze({
      basename: "index2.chunk-BCdS6ADu.js",
      hash: "e2a496d092c2e328b186425660fbf36a39e36b3ecadb4d5c8a2fae0ae9ac0ec1",
      exportSlot: "t",
    }),
  })],
]);

const moduleInternals = Module as unknown as ModuleInternals;

export function installModuleObserver(
  options: InstallModuleObserverOptions,
): ClaudeDesktopMcpCompatibility {
  let status: ClaudeDesktopMcpCompatibility["status"] = "probing";
  let bindings: ClaudeDesktopMcpBindings | null = null;
  const observed: ObservedBindings = {};
  const originalLoad = moduleInternals._load;
  const hashFile = options.hashFile ?? sha256File;
  const compatibilityRecord = COMPATIBILITY_RECORDS.get(options.desktopVersion);
  let wrapper: ModuleLoad | null = null;

  const restore = (): void => {
    if (wrapper && moduleInternals._load === wrapper) moduleInternals._load = originalLoad;
  };
  const log = (
    moduleBasename: string,
    outcome: boolean,
    category: ClaudeDesktopMcpProbeCategory,
  ): void => {
    try {
      options.log?.({
        version: options.desktopVersion,
        basename: moduleBasename,
        outcome,
        category,
      });
    } catch {}
  };
  const fail = (moduleBasename: string, category: ClaudeDesktopMcpProbeCategory): void => {
    if (status !== "probing") return;
    status = "unsupported";
    bindings = null;
    restore();
    log(moduleBasename, false, category);
  };

  const compatibility: ClaudeDesktopMcpCompatibility = {
    get status() {
      return status;
    },
    get bindings() {
      return bindings;
    },
    dispose() {
      if (status === "probing") status = "unsupported";
      restore();
    },
  };

  if (!compatibilityRecord) {
    fail("", "version");
    return compatibility;
  }

  wrapper = function claudeDesktopMcpModuleObserver(this: unknown, request, parent, isMain) {
    const loaded = Reflect.apply(originalLoad, this, [request, parent, isMain]) as unknown;
    if (status !== "probing") return loaded;

    let resolvedFilename: string;
    try {
      resolvedFilename = moduleInternals._resolveFilename(request, parent, isMain);
    } catch {
      fail("", "resolution");
      return loaded;
    }

    const moduleBasename = basename(resolvedFilename);
    const expected = findExpectedModule(compatibilityRecord, moduleBasename);
    if (!expected || observed[expected.role]) return loaded;

    let actualHash: string;
    try {
      actualHash = hashFile(resolvedFilename);
    } catch {
      fail(moduleBasename, "hash");
      return loaded;
    }
    if (actualHash !== expected.hash) {
      fail(moduleBasename, "hash");
      return loaded;
    }

    const captured = captureBinding(expected.role, expected.exportSlot, loaded);
    if (!captured) {
      fail(moduleBasename, "shape");
      return loaded;
    }
    assignBinding(observed, expected.role, captured);
    log(moduleBasename, true, "none");

    if (!hasAllBindings(observed)) return loaded;
    bindings = {
      coordinatorConstructor: observed.coordinator,
      createSdkMcpServer: observed.sdk,
      sessionManager: observed.session,
      jsonSchemaToZodShape: observed.schema,
    };
    status = "supported";
    restore();
    try {
      options.onBindings(bindings);
    } catch {
      log(moduleBasename, false, "consumer");
    }
    return loaded;
  };
  moduleInternals._load = wrapper;
  return compatibility;
}

function findExpectedModule(
  record: CompatibilityRecord,
  moduleBasename: string,
): (ExpectedModule & { role: ModuleRole }) | null {
  for (const role of MODULE_ROLES) {
    const expected = record[role];
    if (expected.basename === moduleBasename) return { role, ...expected };
  }
  return null;
}

function captureBinding(role: ModuleRole, exportSlot: string, loaded: unknown): unknown {
  const exports = asRecord(loaded);
  if (!exports) return null;
  try {
    const exported = exports[exportSlot];
    if (role === "coordinator") {
      const coordinator = exported;
      const prototype = typeof coordinator === "function"
        ? (coordinator as { prototype?: Record<string, unknown> }).prototype
        : undefined;
      if (!prototype || typeof prototype.createAllServers !== "function") {
        return null;
      }
      return coordinator;
    }
    if (role === "sdk") return typeof exported === "function" ? exported : null;
    if (role === "schema") return typeof exported === "function" ? exported : null;

    const sessionManager = asRecord(exported);
    if (
      !sessionManager
      || !(sessionManager.sessions instanceof Map)
      || typeof sessionManager.getSession !== "function"
      || typeof sessionManager.updateSession !== "function"
      || typeof sessionManager.applyMcpServersIfIdle !== "function"
    ) {
      return null;
    }
    return sessionManager;
  } catch {
    return null;
  }
}

function assignBinding(observed: ObservedBindings, role: ModuleRole, binding: unknown): void {
  if (role === "coordinator") {
    observed.coordinator = binding as ClaudeDesktopMcpBindings["coordinatorConstructor"];
  } else if (role === "sdk") {
    observed.sdk = binding as ClaudeDesktopMcpBindings["createSdkMcpServer"];
  } else if (role === "session") {
    observed.session = binding as ClaudeDesktopMcpBindings["sessionManager"];
  } else {
    observed.schema = binding as ClaudeDesktopMcpBindings["jsonSchemaToZodShape"];
  }
}

function hasAllBindings(observed: ObservedBindings): observed is Required<ObservedBindings> {
  return Boolean(observed.coordinator && observed.sdk && observed.session && observed.schema);
}

function sha256File(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
