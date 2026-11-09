import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { installSessionStatsAdapter } from "../src/session-stats-compat.ts";
import { SessionStatsService } from "../src/session-stats-service.ts";

const nativePath = "C:/Claude/resources/app.asar/.vite/build/index.chunk-CUXoxsyW.js";
const nativeHash = "8a49065ed8437a1e4d91c972524044ad58c73eebcac521729a9bc9d9472fab32";
const connectionMarker = "s.transport=o,s.lastSequenceNum=o.getSequenceNum,s.transportConnectedAt=null,o.setOnData((t=>{";
const inboundMarker = "try{let n=JSON.parse(t);this.handleInboundMessage(e,n)}catch(t){";
const closeMarker = 'o.setOnClose((t=>{P.info(`${L8} Transport permanently closed for session ${e} code=${t}`);';
const fixture = `let P={info(){}},L8='bridge';
  class Host {
    constructor(){this.activeSessions=new Map;this.orgUuid='11111111-1111-4111-8111-111111111111';
      this.isDisposed=false;this.handled=[];}
    async connect(e,o){let s=this.activeSessions.get(e);${connectionMarker}
      ${inboundMarker}throw t;}})),${closeMarker}s.transport=null;}));}
    handleInboundMessage(e,n){this.handled.push([e,n]);}
  }
  globalThis.Host=Host;`;
const org = "11111111-1111-4111-8111-111111111111";
const now = 1794196800000;
const request = { subtype: "claudepp_session_stats", protocolVersion: 1, organizationId: org };
const frame = (id = "request-1", extra = {}) => ({ type: "control_request", request_id: id,
  session_id: "session_spoofed", request, ...extra });
const snapshot = (agentId?: string) => ({ schemaVersion: agentId ? 2 : 1, producer: "claude-session-stats",
  bridgeSessionId: "session_abc", organizationId: org,
  publisherId: "22222222-2222-4222-8222-222222222222", revision: 1, generatedAt: now,
  stats: { turns: 2, steps: 3, totalTokens: 50, inputTokens: 40, outputTokens: 10,
    cachedInputTokens: 20, cacheHit: 0.5, tps: 12, usageComplete: true, status: "ok" },
  ...(agentId ? { agentId } : {}),
});

function transport() {
  return { sent: [] as any[], connected: true, onData: (_text: string) => {}, onClose: (_code: number) => {},
    isConnectedStatus() { return this.connected; },
    async write(value: unknown) { this.sent.push(value); },
    setOnData(fn: (text: string) => void) { this.onData = fn; },
    setOnClose(fn: (code: number) => void) { this.onClose = fn; },
    close() { this.connected = false; this.onClose(1000); },
  };
}
async function setup() {
  let source = "";
  const prototype = { _compile(contents: string, _path: string) { source = contents; } };
  const service = new SessionStatsService({ desktopVersion: "4.23118.0", now: () => now,
    installAdapter: options => installSessionStatsAdapter({ ...options, modulePrototype: prototype,
      hashSource: () => nativeHash }) });
  service.installEarly();
  prototype._compile(fixture, nativePath);
  const symbol = Symbol.for("claudepp:session-stats:answer");
  const sandbox: any = { Symbol, [symbol]: (globalThis as any)[symbol] };
  vm.runInNewContext(source, sandbox);
  const host = new sandbox.Host();
  const native = transport();
  const entry = { transport: null, writeQueue: Promise.resolve(), workSecret: {} };
  host.activeSessions.set("cse_abc", entry);
  await host.connect("cse_abc", native);
  const lease = service.createApiLease();
  return { service, lease, host, native, entry, prototype, source: () => source };
}
const settle = async () => { await new Promise<void>(done => setImmediate(done)); };

test("CCR stats use native bridge/org identity and existing write queue for correlated main/child replies", async () => {
  const f = await setup();
  try {
    let received: any;
    f.lease.api.registerProvider(context => { received = context; return snapshot(context.agentId); });
    f.native.onData(JSON.stringify(frame()));
    await settle();
    assert.equal(received.bridgeSessionId, "session_abc");
    assert.equal(received.organizationId, org);
    assert.equal(f.native.sent.length, 1);
    assert.equal(f.native.sent[0].session_id, "cse_abc");
    assert.equal(f.native.sent[0].response.request_id, "request-1");
    assert.deepEqual(f.native.sent[0].response.response, { protocolVersion: 1, snapshot: snapshot() });
    f.native.onData(JSON.stringify(frame("child-request", { request: { ...request, agentId: "child-1" } })));
    await settle();
    assert.equal(f.native.sent[1].response.response.snapshot.agentId, "child-1");
    assert.equal(f.host.handled.length, 0);
  } finally { f.service.dispose(); }
});

test("CCR unknown, interrupt, stop_task and unrelated cancellation retain native dispatch", async () => {
  const f = await setup();
  try {
    const values = [frame("x", { request: { subtype: "unknown" } }),
      frame("interrupt", { request: { subtype: "interrupt" } }),
      frame("stop", { request: { subtype: "stop_task", task_id: "task-1" } }),
      { type: "control_cancel_request", request_id: "unrelated" }, { type: "user", text: "hello" }];
    for (const value of values) f.native.onData(JSON.stringify(value));
    assert.equal(f.host.handled.length, values.length);
    assert.equal(f.native.sent.length, 0);
  } finally { f.service.dispose(); }
});

test("CCR cancellation aborts only its stats provider and suppresses queued replies", async () => {
  const f = await setup();
  try {
    let signal: AbortSignal | undefined;
    f.lease.api.registerProvider(context => { signal = context.signal; return new Promise(() => {}); });
    f.native.onData(JSON.stringify(frame()));
    f.native.onData(JSON.stringify({ type: "control_cancel_request", request_id: "request-1" }));
    await settle();
    assert.equal(signal?.aborted, true);
    assert.equal(f.native.sent.length, 0);
    assert.equal(f.host.handled.length, 0);
  } finally { f.service.dispose(); }

  const queued = await setup();
  let release!: () => void;
  try {
    queued.entry.writeQueue = new Promise<void>(done => { release = done; });
    queued.lease.api.registerProvider(() => snapshot());
    queued.native.onData(JSON.stringify(frame()));
    await settle();
    queued.native.onData(JSON.stringify({ type: "control_cancel_request", request_id: "request-1" }));
    release();
    await settle();
    assert.equal(queued.native.sent.length, 0);
    assert.equal(queued.host.handled.length, 0);
  } finally { release?.(); queued.service.dispose(); }
});

test("CCR close, host stop, entry replacement and same-object reconnect discard pending work", async () => {
  for (const action of ["close", "stop", "entry", "reconnect", "secret"] as const) {
    const f = await setup();
    try {
      let complete!: (value: any) => void;
      f.lease.api.registerProvider(() => new Promise(done => { complete = done; }));
      f.native.onData(JSON.stringify(frame()));
      if (action === "close") f.native.close();
      if (action === "stop") f.host.isDisposed = true;
      if (action === "entry") f.host.activeSessions.set("cse_abc", { ...f.entry });
      if (action === "secret") f.entry.workSecret = {};
      if (action === "reconnect") {
        f.native.close(); f.native.connected = true; await f.host.connect("cse_abc", f.native);
      }
      complete(snapshot());
      await settle();
      assert.equal(f.native.sent.length, 0, action);
    } finally { f.service.dispose(); }
  }
});

test("CCR lease revocation and native organization mismatch fail closed", async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.lease.api.registerProvider(() => { calls++; return snapshot(); });
    f.native.onData(JSON.stringify(frame("foreign", { request: { ...request,
      organizationId: "33333333-3333-4333-8333-333333333333" } })));
    await settle();
    assert.equal(calls, 0);
    assert.equal(f.native.sent[0].response.error, "session-stats-invalid");
    f.lease.dispose();
    f.native.onData(JSON.stringify(frame()));
    await settle();
    assert.equal(f.native.sent[1].response.error, "session-stats-unsupported");
  } finally { f.service.dispose(); }
});

test("CCR native queue guards still reject replies after aggregation has completed", async () => {
  for (const action of ["lease", "host", "connection"] as const) {
    const f = await setup();
    let release!: () => void;
    try {
      f.entry.writeQueue = new Promise<void>(done => { release = done; });
      f.lease.api.registerProvider(() => snapshot());
      f.native.onData(JSON.stringify(frame()));
      await settle();
      if (action === "lease") f.lease.dispose();
      if (action === "host") f.host.isDisposed = true;
      if (action === "connection") f.native.close();
      release();
      await settle();
      assert.equal(f.native.sent.length, 0, action);
    } finally { release?.(); f.service.dispose(); }
  }
});

test("CCR bounds queued replies while the native writer is blocked and releases connection slots", async () => {
  const f = await setup();
  let release!: () => void;
  try {
    f.entry.writeQueue = new Promise<void>(done => { release = done; });
    let calls = 0;
    f.lease.api.registerProvider(() => { calls++; return snapshot(); });
    for (let index = 0; index < 32; index++) f.native.onData(JSON.stringify(frame(`queued-${index}`)));
    await settle();
    assert.equal(calls, 8);
    assert.equal(f.native.sent.length, 0);
    assert.equal(f.host.handled.length, 0);
    release();
    await settle();
    assert.equal(f.native.sent.length, 8);
    f.native.onData(JSON.stringify(frame("after-drain")));
    await settle();
    assert.equal(calls, 9);
    assert.equal(f.native.sent.length, 9);
  } finally { release?.(); f.service.dispose(); }
});

test("CCR compatibility requires its own exact path/hash and all single markers", () => {
  for (const [path, source, hash] of [[nativePath, fixture, "wrong"],
    ["C:/elsewhere/index.chunk-CUXoxsyW.js", fixture, nativeHash],
    [nativePath, fixture.replace(inboundMarker, "try{this.handleInboundMessage(e,JSON.parse(t))}catch(t){"), nativeHash],
    [nativePath, fixture + closeMarker, nativeHash]]) {
    let compiled = "";
    const prototype = { _compile(contents: string, _path: string) { compiled = contents; } };
    const adapter = installSessionStatsAdapter({ desktopVersion: "4.23118.0", modulePrototype: prototype,
      hashSource: () => hash, answer: () => undefined });
    try { prototype._compile(source, path); assert.equal(compiled, source); }
    finally { adapter.dispose(); }
  }
});
