import type {
  TweakManifest,
  TweakMcpApi,
  TweakMcpCallResult,
  TweakMcpServer,
  TweakMcpTool,
  TweakMcpToolContext,
} from "@claude-plusplus/sdk";

export type RegisteredTweakMcpJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RegisteredTweakMcpJsonValue[]
  | RegisteredTweakMcpJsonObject;

export interface RegisteredTweakMcpJsonObject {
  readonly [key: string]: RegisteredTweakMcpJsonValue;
}

export interface RegisteredTweakMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: RegisteredTweakMcpJsonObject;
}

export interface RegisteredTweakMcpServer {
  readonly tweakId: string;
  readonly name: string;
  readonly version?: string;
  readonly tools: readonly RegisteredTweakMcpTool[];
}

export interface TweakMcpRegistryChange {
  readonly snapshot: readonly RegisteredTweakMcpServer[];
  readonly managedNames: readonly string[];
}

export interface TweakMcpApiLease {
  readonly api: TweakMcpApi;
  dispose(): Promise<void>;
}

export interface TweakMcpRegistryOptions {
  readonly onSubscriberError?: (error: unknown) => void;
}

interface LeaseState {
  active: boolean;
  tweakId: string;
  registrations: Set<RegistrationState>;
}

interface RegistrationState {
  active: boolean;
  lease: LeaseState;
  name: string;
  token: symbol;
}

interface RegistryEntry {
  definition: RegisteredTweakMcpServer;
  fingerprint: string;
  lease: LeaseState;
  token: symbol;
  tools: ReadonlyMap<string, TweakMcpTool>;
}

interface ValidatedServer {
  definition: RegisteredTweakMcpServer;
  fingerprint: string;
  tools: ReadonlyMap<string, TweakMcpTool>;
}

type RegistrySubscriber = (change: TweakMcpRegistryChange) => void;

const SERVER_NAME_PATTERN = /^claudepp_[a-z0-9_-]+$/;
const TOOL_NAME_PATTERN = /^[a-z0-9_-]+$/;

export class TweakMcpRegistry {
  private readonly activeServers = new Map<string, RegistryEntry>();
  private readonly fingerprints = new Map<string, string>();
  private readonly managedNames = new Set<string>();
  private readonly subscribers = new Set<RegistrySubscriber>();
  private readonly onSubscriberError?: (error: unknown) => void;

  constructor(options: TweakMcpRegistryOptions = {}) {
    this.onSubscriberError = options.onSubscriberError;
  }

  createApiLease(manifest: Readonly<TweakManifest>): TweakMcpApiLease {
    const lease: LeaseState = {
      active: true,
      tweakId: manifest.id,
      registrations: new Set(),
    };
    const api: TweakMcpApi = {
      registerServer: async (server) => {
        this.assertLeaseActive(lease);
        return this.registerServer(lease, server);
      },
    };

    return {
      api,
      dispose: async () => {
        if (!lease.active) return;

        lease.active = false;
        for (const registration of lease.registrations) {
          registration.active = false;
          const current = this.activeServers.get(registration.name);
          if (current?.token === registration.token) {
            this.activeServers.delete(registration.name);
          }
        }
        lease.registrations.clear();
        this.emitChange();
      },
    };
  }

  snapshot(): readonly RegisteredTweakMcpServer[] {
    return Object.freeze([...this.activeServers.values()]
      .filter((entry) => entry.lease.active)
      .map((entry) => entry.definition)
      .sort((left, right) => left.name.localeCompare(right.name)));
  }

  async invoke(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    context: TweakMcpToolContext,
  ): Promise<TweakMcpCallResult> {
    const entry = this.activeServers.get(serverName);
    if (!entry || !entry.lease.active) {
      throw new Error(`MCP server "${serverName}" is not active`);
    }

    const tool = entry.tools.get(toolName);
    if (!tool) {
      throw new Error(`MCP tool "${serverName}.${toolName}" is not active`);
    }

    return await tool.handler(input, context);
  }

  subscribe(subscriber: RegistrySubscriber): () => void {
    this.subscribers.add(subscriber);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(subscriber);
    };
  }

  private registerServer(lease: LeaseState, server: TweakMcpServer) {
    const validated = validateServer(lease.tweakId, server);
    const current = this.activeServers.get(server.name);
    if (current && current.lease.tweakId !== lease.tweakId) {
      throw new Error(`MCP server "${server.name}" is already active`);
    }

    const priorFingerprint = this.fingerprints.get(server.name);
    if (priorFingerprint !== undefined && priorFingerprint !== validated.fingerprint) {
      throw new Error(`MCP server "${server.name}" has a different structural definition`);
    }

    const registration: RegistrationState = {
      active: true,
      lease,
      name: server.name,
      token: Symbol(server.name),
    };
    lease.registrations.add(registration);
    this.activeServers.set(server.name, {
      ...validated,
      lease,
      token: registration.token,
    });
    this.fingerprints.set(server.name, validated.fingerprint);
    this.managedNames.add(server.name);
    this.emitChange();

    return {
      unregister: async () => {
        this.assertLeaseActive(lease);
        if (!registration.active) return;

        registration.active = false;
        lease.registrations.delete(registration);
        const active = this.activeServers.get(registration.name);
        if (active?.token !== registration.token) return;

        this.activeServers.delete(registration.name);
        this.emitChange();
      },
    };
  }

  private assertLeaseActive(lease: LeaseState): void {
    if (!lease.active) {
      throw new Error(`MCP API lease for Tweak "${lease.tweakId}" is disposed`);
    }
  }

  private emitChange(): void {
    const change: TweakMcpRegistryChange = {
      snapshot: this.snapshot(),
      managedNames: Object.freeze([...this.managedNames].sort()),
    };
    const immutableChange = Object.freeze(change);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(immutableChange);
      } catch (error) {
        this.reportSubscriberError(error);
      }
    }
  }

  private reportSubscriberError(error: unknown): void {
    if (this.onSubscriberError) {
      try {
        this.onSubscriberError(error);
      } catch {}
      return;
    }

    try {
      console.error("[Claude++] Tweak MCP registry subscriber failed", error);
    } catch {}
  }
}

function validateServer(tweakId: string, server: TweakMcpServer): ValidatedServer {
  if (!isRecord(server)) {
    throw new Error("MCP server must be an object");
  }
  if (typeof server.name !== "string" || !server.name.startsWith("claudepp_")) {
    throw new Error("MCP server name must start with claudepp_");
  }
  if (!SERVER_NAME_PATTERN.test(server.name)) {
    throw new Error("MCP server name may only contain lowercase letters, digits, underscores, and dashes");
  }
  if (server.version !== undefined && typeof server.version !== "string") {
    throw new Error("MCP server version must be a string");
  }
  if (!Array.isArray(server.tools) || server.tools.length === 0) {
    throw new Error("MCP server must contain at least one tool");
  }

  const names = new Set<string>();
  const definitions: RegisteredTweakMcpTool[] = [];
  const handlers = new Map<string, TweakMcpTool>();
  for (const tool of server.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error("MCP tool name may only contain lowercase letters, digits, underscores, and dashes");
    }
    if (names.has(tool.name)) {
      throw new Error(`MCP server "${server.name}" has duplicate tool name "${tool.name}"`);
    }
    if (typeof tool.description !== "string") {
      throw new Error(`MCP tool "${tool.name}" description must be a string`);
    }
    if (!isRecord(tool.inputSchema)) {
      throw new Error(`MCP tool "${tool.name}" input schema must be an object`);
    }
    if (typeof tool.handler !== "function") {
      throw new Error(`MCP tool "${tool.name}" handler must be a function`);
    }

    names.add(tool.name);
    definitions.push(Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeJsonObject(tool.inputSchema, `MCP tool "${tool.name}" input schema`),
    }));
    handlers.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: tool.handler as TweakMcpTool["handler"],
    });
  }
  definitions.sort((left, right) => left.name.localeCompare(right.name));
  const immutableDefinitions = Object.freeze(definitions);

  const definition: RegisteredTweakMcpServer = Object.freeze({
    tweakId,
    name: server.name,
    ...(server.version === undefined ? {} : { version: server.version }),
    tools: immutableDefinitions,
  });
  const fingerprint = JSON.stringify({
    name: definition.name,
    version: definition.version ?? null,
    tools: definition.tools,
  });
  return { definition, fingerprint, tools: handlers };
}

function canonicalizeJsonObject(
  value: Record<string, unknown>,
  label: string,
): RegisteredTweakMcpJsonObject {
  return canonicalizeJson(value, label, new Set()) as RegisteredTweakMcpJsonObject;
}

function canonicalizeJson(value: unknown, label: string, parents: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON values`);
  }
  if (parents.has(value)) {
    throw new Error(`${label} must not contain circular references`);
  }

  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => canonicalizeJson(item, label, parents)));
    }
    if (!isPlainJsonObject(value)) {
      throw new Error(`${label} must contain only plain JSON objects`);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeJson(value[key], label, parents);
    }
    return Object.freeze(result);
  } finally {
    parents.delete(value);
  }
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
