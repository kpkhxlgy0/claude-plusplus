import type { SessionStatsApi, SessionStatsProvider } from "@claude-plusplus/sdk";
import {
  installSessionStatsAdapter,
  type NativeSessionStatsContext,
  type SessionStatsAdapterOptions,
  type SessionStatsControlResult,
} from "./session-stats-compat";

export interface SessionStatsApiLease {
  readonly api: SessionStatsApi;
  dispose(): void;
}

interface ServiceOptions {
  desktopVersion: string;
  installAdapter?: typeof installSessionStatsAdapter;
  now?: () => number;
  timeoutMs?: number;
}

interface ProviderRegistration {
  handler: SessionStatsProvider;
  requests: Set<AbortController>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const counters = ["turns", "steps", "totalTokens", "inputTokens", "outputTokens", "cachedInputTokens"];
const statKeys = [...counters, "cacheHit", "tps", "usageComplete", "status"];
const rootKeys = ["schemaVersion", "producer", "bridgeSessionId", "organizationId", "publisherId",
  "revision", "generatedAt", "stats"];
const invalid = (): SessionStatsControlResult => ({ subtype: "error", error: "session-stats-invalid" });
const unavailable = (): SessionStatsControlResult => ({ subtype: "error", error: "session-stats-unavailable" });

export class SessionStatsService {
  private readonly options: ServiceOptions;
  private readonly leases = new Set<SessionStatsApiLease>();
  private readonly requests = new Set<AbortController>();
  private readonly connectionRequests = new WeakMap<Map<string, AbortController>, number>();
  private registration: ProviderRegistration | undefined;
  private adapter: ReturnType<typeof installSessionStatsAdapter> | undefined;
  private disposed = false;

  public constructor(options: ServiceOptions) { this.options = options; }

  public installEarly(): void {
    if (this.disposed || this.adapter) return;
    this.adapter = (this.options.installAdapter ?? installSessionStatsAdapter)({
      desktopVersion: this.options.desktopVersion,
      answer: (request, context) => this.answer(request, context),
    });
  }

  public createApiLease(): SessionStatsApiLease {
    if (this.disposed) throw new Error("Session stats service is disposed");
    let active = true;
    let owned: ProviderRegistration | undefined;
    const revoke = (): void => {
      if (!owned) return;
      if (this.registration === owned) this.registration = undefined;
      for (const controller of owned.requests) controller.abort();
      owned = undefined;
    };
    const lease: SessionStatsApiLease = {
      api: {
        registerProvider: (handler) => {
          if (!active || this.disposed) throw new Error("Session stats API lease is disposed");
          if (typeof handler !== "function") throw new Error("Session stats provider must be a function");
          if (this.registration) throw new Error("Session stats provider is already registered");
          const registration = { handler, requests: new Set<AbortController>() };
          this.registration = owned = registration;
          return { unregister: () => { if (owned === registration) revoke(); } };
        },
      },
      dispose: () => {
        if (!active) return;
        active = false;
        revoke();
        this.leases.delete(lease);
      },
    };
    this.leases.add(lease);
    return lease;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lease of [...this.leases]) lease.dispose();
    this.adapter?.dispose();
  }

  private answer: SessionStatsAdapterOptions["answer"] = (request, context) => {
    if (!record(request) || request.subtype !== "claudepp_session_stats") return undefined;
    context.canWrite = () => !this.disposed && context.isCurrent();
    const child = Object.hasOwn(request, "agentId");
    const bridgeSessionId = normalizeBridgeId(context.bridgeSessionId);
    if (!exactKeys(request, ["subtype", "protocolVersion", "organizationId", ...(child ? ["agentId"] : [])])
      || request.protocolVersion !== 1 || typeof request.organizationId !== "string"
      || !uuid.test(request.organizationId) || child && !validAgentId(request.agentId)
      || context.organizationId !== undefined && context.organizationId.toLowerCase() !== request.organizationId.toLowerCase()
      || !bridgeSessionId || typeof context.requestId !== "string" || !context.requestId
      || context.requestId.length > 128 || !context.isCurrent()) return Promise.resolve(invalid());
    const registration = this.registration;
    if (this.disposed || !registration) {
      return Promise.resolve({ subtype: "error", error: "session-stats-unsupported" });
    }
    if (context.cancellableRequests.has(context.requestId)) {
      context.canWrite = () => false;
      return Promise.resolve(invalid());
    }
    const connectionCount = this.connectionRequests.get(context.cancellableRequests) ?? 0;
    if (this.requests.size >= 32 || connectionCount >= 8) return Promise.resolve(unavailable());
    const controller = new AbortController();
    let timedOut = false;
    context.canWrite = () => !this.disposed && this.registration === registration
      && (!controller.signal.aborted || timedOut) && context.isCurrent();
    context.cancellableRequests.set(context.requestId, controller);
    registration.requests.add(controller);
    this.requests.add(controller);
    this.connectionRequests.set(context.cancellableRequests, connectionCount + 1);
    const binding = Object.freeze({ bridgeSessionId, organizationId: request.organizationId.toLowerCase(),
      ...(child ? { agentId: request.agentId as string } : {}), signal: controller.signal });
    return this.invokeProvider(registration, binding, context, controller, () => { timedOut = true; });
  };

  private async invokeProvider(
    registration: ProviderRegistration,
    binding: Parameters<SessionStatsProvider>[0],
    context: NativeSessionStatsContext,
    controller: AbortController,
    onTimeout: () => void,
  ): Promise<SessionStatsControlResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("cancelled"));
        controller.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { onTimeout(); controller.abort(); }, this.options.timeoutMs ?? 5000);
      });
      const snapshot = await Promise.race([registration.handler(binding), cancelled]);
      if (!context.canWrite?.()) return unavailable();
      if (snapshot === null) return unavailable();
      const validated = validateSnapshot(snapshot, binding, (this.options.now ?? Date.now)());
      return validated
        ? { subtype: "success", response: { protocolVersion: 1, snapshot: validated } }
        : invalid();
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      registration.requests.delete(controller);
      this.requests.delete(controller);
      const connectionCount = (this.connectionRequests.get(context.cancellableRequests) ?? 1) - 1;
      if (connectionCount > 0) this.connectionRequests.set(context.cancellableRequests, connectionCount);
      else this.connectionRequests.delete(context.cancellableRequests);
      if (context.cancellableRequests.get(context.requestId) === controller) {
        context.cancellableRequests.delete(context.requestId);
      }
    }
  }
}

function validateSnapshot(
  value: unknown,
  expected: Parameters<SessionStatsProvider>[0],
  now: number,
): Record<string, unknown> | null {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("invalid number");
      return item;
    });
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16384) return null;
    value = JSON.parse(text) as unknown;
  } catch { return null; }
  if (!record(value)) return null;
  const child = value.schemaVersion === 2;
  if (!exactKeys(value, [...rootKeys, ...(child ? ["agentId"] : [])])
    || ![1, 2].includes(value.schemaVersion as number) || value.producer !== "claude-session-stats"
    || value.bridgeSessionId !== expected.bridgeSessionId || value.organizationId !== expected.organizationId
    || child !== (expected.agentId !== undefined) || child && value.agentId !== expected.agentId
    || typeof value.publisherId !== "string" || !uuid.test(value.publisherId)
    || value.publisherId !== value.publisherId.toLowerCase()
    || !integer(value.revision) || value.revision === 0 || !integer(value.generatedAt)
    || value.generatedAt - now > 5000 || now - value.generatedAt > 30000
    || !exactKeys(value.stats, statKeys)) return null;
  const stats = value.stats as Record<string, unknown>;
  if (!["ok", "incomplete", "not-found", "unavailable"].includes(stats.status as string)
    || typeof stats.usageComplete !== "boolean") return null;
  for (const key of counters) if (stats[key] !== null && !integer(stats[key])) return null;
  if (stats.cacheHit !== null && (typeof stats.cacheHit !== "number" || !Number.isFinite(stats.cacheHit)
    || stats.cacheHit < 0 || stats.cacheHit > 1)) return null;
  if (stats.tps !== null && (typeof stats.tps !== "number" || !Number.isFinite(stats.tps) || stats.tps <= 0)) return null;
  if (stats.status !== "ok" && (stats.usageComplete || [...counters, "cacheHit", "tps"].some(key => stats[key] !== null))) {
    return null;
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: string[]): boolean {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function normalizeBridgeId(value: unknown): string | null {
  const match = typeof value === "string" && /^(?:cse_|session_)([A-Za-z0-9_-]{1,128})$/.exec(value);
  return match ? `session_${match[1]}` : null;
}
function validAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
