import type {
  ClaudeSessionTitlesApi,
  ClaudeSessionTitleUpdate,
  TweakManifest,
} from "@claude-plusplus/sdk";
import {
  installModuleObserver,
  type ClaudeDesktopMcpBindings,
  type ClaudeDesktopMcpCompatibility,
  type InstallModuleObserverOptions,
  type SdkMcpServer,
} from "./claude-desktop-mcp-compat";
import {
  TweakMcpRegistry,
  type TweakMcpRegistryChange,
  type RegisteredTweakMcpServer,
  type TweakMcpApiLease,
} from "./tweak-mcp-registry";

export interface ClaudeDesktopMcpServiceLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ClaudeDesktopMcpServiceOptions {
  desktopVersion: string;
  registry?: TweakMcpRegistry;
  installModuleObserver?: (
    options: InstallModuleObserverOptions,
  ) => ClaudeDesktopMcpCompatibility;
  log?: ClaudeDesktopMcpServiceLog;
}

interface CoordinatorPrototype {
  createAllServers: (...args: unknown[]) => Promise<Record<string, unknown>>;
}

interface CoordinatorInstance {
  sessionType?: unknown;
}

interface CoordinatorPatch {
  prototype: CoordinatorPrototype;
  original: CoordinatorPrototype["createAllServers"];
  wrapper: CoordinatorPrototype["createAllServers"];
}

interface ManagedMcpApiLease extends TweakMcpApiLease {
  dispose(): Promise<void>;
}

export interface ClaudeSessionTitlesApiLease {
  readonly api: ClaudeSessionTitlesApi;
  dispose(): Promise<void>;
}

interface ManagedSessionTitlesApiLease extends ClaudeSessionTitlesApiLease {
  dispose(): Promise<void>;
}

interface ActiveDesktopSession {
  activeMcpServers: Record<string, unknown>;
  isRunning?: unknown;
  query: unknown;
  sessionId?: unknown;
}

const NOOP_LOG: ClaudeDesktopMcpServiceLog = {
  info() {},
  warn() {},
  error() {},
};

export class ClaudeDesktopMcpService {
  private readonly desktopVersion: string;
  private readonly registry: TweakMcpRegistry;
  private readonly observerInstaller: NonNullable<
    ClaudeDesktopMcpServiceOptions["installModuleObserver"]
  >;
  private readonly log: ClaudeDesktopMcpServiceLog;
  private readonly mcpApiLeases = new Set<ManagedMcpApiLease>();
  private readonly sessionTitlesApiLeases = new Set<ManagedSessionTitlesApiLease>();
  private readonly managedNames = new Set<string>();
  private readonly sessionServers = new Map<string, Map<string, SdkMcpServer>>();
  private readonly unsubscribeRegistry: () => void;
  private compatibility: ClaudeDesktopMcpCompatibility | null = null;
  private bindings: ClaudeDesktopMcpBindings | null = null;
  private coordinatorPatch: CoordinatorPatch | null = null;
  private reconciliationQueue: Promise<void> = Promise.resolve();
  private installed = false;
  private disposed = false;

  public constructor(options: ClaudeDesktopMcpServiceOptions) {
    this.desktopVersion = options.desktopVersion;
    this.registry = options.registry ?? new TweakMcpRegistry();
    this.observerInstaller = options.installModuleObserver ?? installModuleObserver;
    this.log = options.log ?? NOOP_LOG;
    this.unsubscribeRegistry = this.registry.subscribe((change) => {
      this.recordManagedNames(change);
      void this.enqueueReconciliation(change.snapshot);
    });
  }

  public createMcpApiLease(manifest: Readonly<TweakManifest>): TweakMcpApiLease {
    this.assertActive();
    const registryLease = this.registry.createApiLease(manifest);
    let active = true;
    const lease: ManagedMcpApiLease = {
      api: registryLease.api,
      dispose: async () => {
        if (!active) return;
        active = false;
        this.mcpApiLeases.delete(lease);
        await registryLease.dispose();
      },
    };
    this.mcpApiLeases.add(lease);
    return lease;
  }

  public createSessionTitlesApiLease(): ClaudeSessionTitlesApiLease {
    this.assertActive();
    let active = true;
    const assertLeaseActive = (): void => {
      if (!active || this.disposed) {
        throw new Error("Claude Desktop session titles API lease is disposed");
      }
    };
    const lease: ManagedSessionTitlesApiLease = {
      api: {
        setTitle: async (sessionId, title) => {
          assertLeaseActive();
          return this.setSessionTitle(sessionId, title);
        },
      },
      dispose: async () => {
        if (!active) return;
        active = false;
        this.sessionTitlesApiLeases.delete(lease);
      },
    };
    this.sessionTitlesApiLeases.add(lease);
    return lease;
  }

  public installEarly(): void {
    this.assertActive();
    if (this.installed) return;
    this.installed = true;
    this.compatibility = this.observerInstaller({
      desktopVersion: this.desktopVersion,
      onBindings: (bindings) => this.attachBindings(bindings),
    });
  }

  public reconcileActiveSessions(): Promise<void> {
    this.assertActive();
    return this.enqueueReconciliation(this.registry.snapshot());
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRegistry();
    const leases = [...this.mcpApiLeases];
    this.mcpApiLeases.clear();
    for (const lease of leases) await lease.dispose();
    const titleLeases = [...this.sessionTitlesApiLeases];
    this.sessionTitlesApiLeases.clear();
    for (const lease of titleLeases) await lease.dispose();
    await this.enqueueReconciliation([]);
    this.restoreCoordinator();
    this.compatibility?.dispose();
    this.compatibility = null;
    this.bindings = null;
  }

  private attachBindings(bindings: ClaudeDesktopMcpBindings): void {
    if (this.disposed) return;
    this.bindings = bindings;
    this.restoreCoordinator();
    const prototype = bindings.coordinatorConstructor.prototype;
    const original = prototype.createAllServers;
    const service = this;
    const wrapper: CoordinatorPrototype["createAllServers"] = async function (
      this: CoordinatorInstance,
      ...args
    ) {
      const originalServers = await Reflect.apply(original, this, args) as Record<string, unknown>;
      const coordinator = this as CoordinatorInstance;
      if (coordinator.sessionType !== "ccd") return originalServers;
      const sessionId = typeof args[0] === "string" ? args[0] : "";
      return service.injectServers(originalServers, sessionId, bindings);
    };
    prototype.createAllServers = wrapper;
    this.coordinatorPatch = { prototype, original, wrapper };
    void this.enqueueReconciliation(this.registry.snapshot());
  }

  private injectServers(
    originalServers: Record<string, unknown>,
    sessionId: string,
    bindings: ClaudeDesktopMcpBindings,
  ): Record<string, unknown> {
    this.sessionServers.delete(sessionId);
    const definitions = this.registry.snapshot();
    for (const definition of definitions) {
      if (!Object.hasOwn(originalServers, definition.name)) continue;
      this.log.warn(
        `[Claude++] MCP server collision for "${definition.name}" in session "${sessionId}"`,
      );
      return originalServers;
    }

    try {
      const injected: Record<string, SdkMcpServer> = {};
      const tracked = new Map<string, SdkMcpServer>();
      for (const definition of definitions) {
        const sdkServer = this.createSdkServer(definition, sessionId, bindings);
        injected[definition.name] = sdkServer;
        tracked.set(definition.name, sdkServer);
      }
      this.sessionServers.set(sessionId, tracked);
      return { ...originalServers, ...injected };
    } catch (error) {
      this.log.error(
        `[Claude++] Failed to create MCP servers for session "${sessionId}": ${errorMessage(error)}`,
      );
      return originalServers;
    }
  }

  private createSdkServer(
    definition: RegisteredTweakMcpServer,
    sessionId: string,
    bindings: ClaudeDesktopMcpBindings,
  ): SdkMcpServer {
    return bindings.createSdkMcpServer({
      name: definition.name,
      ...(definition.version === undefined ? {} : { version: definition.version }),
      alwaysLoad: true,
      tools: definition.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: bindings.jsonSchemaToZodShape(tool.inputSchema),
        handler: async (input: Record<string, unknown>) => {
          try {
            if (this.disposed) throw new Error("Claude Desktop MCP service is disposed");
            return await this.registry.invoke(
              definition.name,
              tool.name,
              input,
              { callerSessionId: sessionId },
            );
          } catch (error) {
            return {
              content: [{ type: "text", text: errorMessage(error) }],
              isError: true,
            };
          }
        },
      })),
    });
  }

  private async setSessionTitle(
    sessionId: string,
    title: string,
  ): Promise<ClaudeSessionTitleUpdate> {
    const targetSessionId = sessionId.trim();
    const nextTitle = title.trim();
    if (!targetSessionId) throw new Error("Session ID must not be empty");
    if (!nextTitle) throw new Error("Session title must not be empty");
    if (nextTitle.length > 200) {
      throw new Error("Session title must not exceed 200 UTF-16 code units");
    }

    const manager = this.bindings?.sessionManager;
    if (!manager) throw new Error("Claude Desktop session titles API is unavailable");
    let desktopSessionId = targetSessionId;
    let existing = await manager.getSession(desktopSessionId);
    if (!existing) {
      const mappedSessionIds = findSessionIdsByCliSessionId(manager.sessions, targetSessionId);
      if (mappedSessionIds.length > 1) {
        throw new Error(`Session "${targetSessionId}" matched multiple Desktop sessions`);
      }
      if (mappedSessionIds.length === 1) {
        desktopSessionId = mappedSessionIds[0];
        existing = await manager.getSession(desktopSessionId);
      }
    }
    if (!existing) throw new Error(`Session "${targetSessionId}" was not found`);

    await manager.updateSession(desktopSessionId, {
      title: nextTitle,
      titleSource: "user",
    });

    const updated = await manager.getSession(desktopSessionId);
    if (!updated || typeof updated !== "object") {
      throw new Error(`Session "${targetSessionId}" was not found after update`);
    }
    if ((updated as { title?: unknown }).title !== nextTitle) {
      throw new Error(`Session "${targetSessionId}" title did not match after update`);
    }
    return { sessionId: targetSessionId, title: nextTitle };
  }

  private restoreCoordinator(): void {
    const patch = this.coordinatorPatch;
    if (!patch) return;
    if (patch.prototype.createAllServers === patch.wrapper) {
      patch.prototype.createAllServers = patch.original;
    }
    this.coordinatorPatch = null;
  }

  private recordManagedNames(change: TweakMcpRegistryChange): void {
    for (const name of change.managedNames) this.managedNames.add(name);
  }

  private enqueueReconciliation(
    definitions: readonly RegisteredTweakMcpServer[],
  ): Promise<void> {
    const run = this.reconciliationQueue.then(
      () => this.performReconciliation(this.disposed ? [] : definitions),
    );
    this.reconciliationQueue = run.catch((error) => {
      this.log.error(`[Claude++] MCP reconciliation failed: ${errorMessage(error)}`);
    });
    return this.reconciliationQueue;
  }

  private async performReconciliation(
    definitions: readonly RegisteredTweakMcpServer[],
  ): Promise<void> {
    const bindings = this.bindings;
    if (!bindings) return;
    const activeNames = new Set(definitions.map((definition) => definition.name));
    const liveSessionIds = new Set<string>();

    for (const [sessionId, value] of bindings.sessionManager.sessions) {
      liveSessionIds.add(sessionId);
      const session = asActiveSession(value);
      if (!session?.query) continue;
      await this.reconcileSession(sessionId, session, definitions, activeNames, bindings);
    }

    for (const sessionId of this.sessionServers.keys()) {
      if (!liveSessionIds.has(sessionId)) this.sessionServers.delete(sessionId);
    }
  }

  private async reconcileSession(
    sessionId: string,
    session: ActiveDesktopSession,
    definitions: readonly RegisteredTweakMcpServer[],
    activeNames: ReadonlySet<string>,
    bindings: ClaudeDesktopMcpBindings,
  ): Promise<void> {
    const previousServers = session.activeMcpServers;
    const nextServers = { ...previousServers };
    const previousTracked = this.sessionServers.get(sessionId) ?? new Map();
    const nextTracked = new Map(previousTracked);

    try {
      for (const name of this.managedNames) {
        if (activeNames.has(name)) continue;
        const injected = nextTracked.get(name);
        if (injected && nextServers[name] === injected) delete nextServers[name];
        nextTracked.delete(name);
      }

      for (const definition of definitions) {
        const tracked = nextTracked.get(definition.name);
        if (Object.hasOwn(nextServers, definition.name)) {
          if (tracked !== nextServers[definition.name]) {
            this.log.warn(
              `[Claude++] MCP server collision for "${definition.name}" in session "${sessionId}"`,
            );
            nextTracked.delete(definition.name);
          }
          continue;
        }

        const sdkServer = tracked ?? this.createSdkServer(definition, sessionId, bindings);
        nextServers[definition.name] = sdkServer;
        nextTracked.set(definition.name, sdkServer);
      }

      session.activeMcpServers = nextServers;
      await bindings.sessionManager.applyMcpServersIfIdle(session, nextServers);
      this.sessionServers.set(sessionId, nextTracked);
    } catch (error) {
      session.activeMcpServers = previousServers;
      this.log.error(
        `[Claude++] Failed to reconcile MCP servers for session "${sessionId}": ${errorMessage(error)}`,
      );
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Claude Desktop MCP service is disposed");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asActiveSession(value: unknown): ActiveDesktopSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<ActiveDesktopSession>;
  if (!session.activeMcpServers || typeof session.activeMcpServers !== "object") return null;
  return session as ActiveDesktopSession;
}

function findSessionIdsByCliSessionId(
  sessions: ReadonlyMap<string, unknown>,
  cliSessionId: string,
): string[] {
  const matches: string[] = [];
  for (const [sessionId, value] of sessions) {
    if (value && typeof value === "object"
      && (value as { cliSessionId?: unknown }).cliSessionId === cliSessionId) {
      matches.push(sessionId);
    }
  }
  return matches;
}
