import assert from "node:assert/strict";
import test from "node:test";
import { SessionStatsService } from "../src/session-stats-service.ts";

const now = 1794196800000;
const org = "11111111-1111-4111-8111-111111111111";
const request = { subtype: "claudepp_session_stats", protocolVersion: 1, organizationId: org };
const snapshot = (agentId?: string) => ({
  schemaVersion: agentId ? 2 : 1, producer: "claude-session-stats",
  bridgeSessionId: "session_abc", organizationId: org,
  publisherId: "22222222-2222-4222-8222-222222222222", revision: 1, generatedAt: now,
  stats: { turns: 2, steps: 3, totalTokens: 50, inputTokens: 40, outputTokens: 10,
    cachedInputTokens: 20, cacheHit: 0.5, tps: 12, usageComplete: true, status: "ok" },
  ...(agentId ? { agentId } : {}),
});
function fixture(options = {}) {
  let handler: any;
  const service = new SessionStatsService({ desktopVersion: "4.23118.0", now: () => now,
    installAdapter: (options: any) => {
      handler = options.answer;
      return { dispose() {} };
    }, ...options });
  service.installEarly();
  const requests = new Map<string, AbortController>();
  const context = () => ({ bridgeSessionId: "cse_abc", requestId: "request-1",
    cancellableRequests: requests, isCurrent: () => true, canWrite: undefined as undefined | (() => boolean) });
  return { service, requests, context, answer: (request: any, context: any) => handler(request, context) };
}

test("binds provider context and response to the authenticated bridge and requested organization/agent", async () => {
  const f = fixture();
  const lease = f.service.createApiLease();
  let received: any;
  lease.api.registerProvider(context => { received = context; return snapshot(); });
  assert.deepEqual(await f.answer(request, f.context()), {
    subtype: "success", response: { protocolVersion: 1, snapshot: snapshot() },
  });
  assert.equal(received.bridgeSessionId, "session_abc");
  assert.equal(received.organizationId, org);
  assert.equal(received.agentId, undefined);
  assert.ok(received.signal instanceof AbortSignal);
  assert.equal(f.requests.size, 0);
  f.service.dispose();
});

test("child requests accept only the exact child snapshot", async () => {
  const f = fixture();
  const lease = f.service.createApiLease();
  const registration = lease.api.registerProvider(() => snapshot("child-1"));
  assert.equal((await f.answer({ ...request, agentId: "child-1" }, f.context())).subtype, "success");
  assert.equal((await f.answer(request, f.context())).error, "session-stats-invalid");
  registration.unregister();
  lease.api.registerProvider(() => snapshot());
  assert.equal((await f.answer({ ...request, agentId: "child-1" }, f.context())).error, "session-stats-invalid");
  f.service.dispose();
});

test("unknown native requests fall through unchanged and malformed stats requests never reach the provider", async () => {
  const f = fixture();
  let calls = 0;
  f.service.createApiLease().api.registerProvider(() => { calls++; return snapshot(); });
  assert.equal(f.answer({ subtype: "read_file" }, f.context()), undefined);
  for (const invalid of [
    { ...request, protocolVersion: 2 }, { ...request, organizationId: "../other" },
    { ...request, agentId: "../child" }, { ...request, bridgeSessionId: "session_other" },
    { ...request, extra: true },
  ]) assert.equal((await f.answer(invalid, f.context())).error, "session-stats-invalid");
  assert.equal((await f.answer(request, { ...f.context(), bridgeSessionId: "../abc" })).error,
    "session-stats-invalid");
  assert.equal(calls, 0);
  f.service.dispose();
});

test("rejects invalid, oversized, stale, future and foreign snapshots without exposing provider errors", async () => {
  const f = fixture();
  const lease = f.service.createApiLease();
  for (const value of [
    { ...snapshot(), bridgeSessionId: "session_other" },
    { ...snapshot(), organizationId: "33333333-3333-4333-8333-333333333333" },
    { ...snapshot(), generatedAt: now - 30001 }, { ...snapshot(), generatedAt: now + 5001 },
    { ...snapshot(), secret: "x".repeat(17000) },
    { ...snapshot(), stats: { ...snapshot().stats, turns: -1 } },
    { ...snapshot(), stats: { ...snapshot().stats, tps: Infinity } },
    { ...snapshot(), stats: { ...snapshot().stats, cacheHit: 2 } },
  ]) {
    const registration = lease.api.registerProvider(() => value);
    assert.equal((await f.answer(request, f.context())).error, "session-stats-invalid");
    registration.unregister();
  }
  const registration = lease.api.registerProvider(() => { throw new Error("C:/private/credentials"); });
  assert.equal((await f.answer(request, f.context())).error, "session-stats-unavailable");
  registration.unregister();
  lease.api.registerProvider(() => null);
  assert.deepEqual(await f.answer(request, f.context()), {
    subtype: "error", error: "session-stats-unavailable",
  });
  f.service.dispose();
});

test("allows one provider and revokes retained registrations synchronously on lease disposal", async () => {
  const f = fixture();
  assert.equal((await f.answer(request, f.context())).error, "session-stats-unsupported");
  const first = f.service.createApiLease();
  const second = f.service.createApiLease();
  first.api.registerProvider(() => snapshot());
  assert.throws(() => second.api.registerProvider(() => snapshot()), /already registered/);
  first.dispose();
  assert.throws(() => first.api.registerProvider(() => snapshot()), /disposed/);
  second.api.registerProvider(() => snapshot());
  assert.equal((await f.answer(request, f.context())).subtype, "success");
  f.service.dispose();
  assert.throws(() => second.api.registerProvider(() => snapshot()), /disposed/);
});

test("native cancellation promptly settles a hanging provider and suppresses its response", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.service.createApiLease().api.registerProvider(context => {
    signal = context.signal;
    return new Promise(() => {});
  });
  const context = f.context();
  const result = f.answer(request, context);
  f.requests.get("request-1")!.abort();
  await result;
  assert.equal(signal?.aborted, true);
  assert.equal(context.canWrite!(), false);
  assert.equal(f.requests.size, 0);
  f.service.dispose();
});

test("unregister/stop and transport replacement suppress already pending results", async () => {
  for (const action of ["unregister", "lease", "service", "transport"] as const) {
    const f = fixture();
    let resolve!: (value: any) => void;
    const lease = f.service.createApiLease();
    const registration = lease.api.registerProvider(() => new Promise(done => { resolve = done; }));
    const context = f.context();
    const result = f.answer(request, context);
    if (action === "unregister") registration.unregister();
    if (action === "lease") lease.dispose();
    if (action === "service") f.service.dispose();
    if (action === "transport") context.isCurrent = () => false;
    resolve(snapshot());
    await result;
    assert.equal(context.canWrite!(), false, action);
    assert.equal(f.requests.size, 0, action);
    f.service.dispose();
  }
});

test("provider timeout is bounded, aborts work and returns unavailable", async () => {
  const f = fixture({ timeoutMs: 5 });
  let signal: AbortSignal | undefined;
  f.service.createApiLease().api.registerProvider(context => {
    signal = context.signal;
    return new Promise(() => {});
  });
  assert.equal((await f.answer(request, f.context())).error, "session-stats-unavailable");
  assert.equal(signal?.aborted, true);
  assert.equal(f.requests.size, 0);
  f.service.dispose();
});

test("bounds in-flight work per native connection and globally, releasing slots after completion", async () => {
  const f = fixture();
  let complete: (value: any) => void = () => {};
  let work = new Promise<any>(resolve => { complete = resolve; });
  let calls = 0;
  f.service.createApiLease().api.registerProvider(() => { calls++; return work; });
  const pending = Array.from({ length: 8 }, (_, index) =>
    f.answer(request, { ...f.context(), requestId: `request-${index}` }));
  assert.equal((await f.answer(request, { ...f.context(), requestId: "ninth" })).error,
    "session-stats-unavailable");
  assert.equal(calls, 8);
  for (let index = 8; index < 32; index++) pending.push(f.answer(request,
    { ...f.context(), cancellableRequests: new Map(), requestId: `request-${index}` }));
  assert.equal((await f.answer(request, { ...f.context(), cancellableRequests: new Map() })).error,
    "session-stats-unavailable");
  assert.equal(calls, 32);
  complete(snapshot());
  await Promise.all(pending);
  work = Promise.resolve(snapshot());
  assert.equal((await f.answer(request, f.context())).subtype, "success");
  assert.equal(f.requests.size, 0);
  f.service.dispose();
});
