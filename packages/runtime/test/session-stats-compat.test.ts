import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { installSessionStatsAdapter } from "../src/session-stats-compat.ts";

const filename = "C:/Claude/resources/app.asar/.vite/build/index.chunk-DhrjLA58.js";
const hash = "c00b0a0617993d7dca342b94cac1fef4ac667f80f8953700b1d3dc87dd4788d4";
const callsite = "e=>zhe(e,{transport:E,sessionId:t,outboundOnly:o,claudeCodeVersion:s,onInterrupt:u,onStopTask:d,onBackgroundTasks:f,getPendingPrompts:()=>[...C.values()],onSetModel:p,onSetMaxThinkingTokens:m,onSetPermissionMode:h,onRenameSession:g,onSideQuestion:_,writeFrame:e=>{T||E.write(e)},cancellableRequests:w})";
const connectMarker = 'function D(){E.setOnConnect((()=>{B(`[bridge:session] Transport connected session=${t}`)})),E.setOnData';
const closeMarker = 'E.setOnClose((e=>{T||(B(`[bridge:session] Transport closed session=${t} code=${e}`),v?.(e))}))';
const fixture = `let E=transport,t='cse_abc',o=false,s='1',u,d,f,C=new Map,p,m,h,g,_,T=false,w=new Map;
  let callback,v;function B(){};
  ${connectMarker}(callback=${callsite}),${closeMarker}}D();
  function zhe(frame,options){return options;}
  globalThis.fixture={callback,replace:next=>{E=next;D()},close:()=>{T=true}};`;

function transport(sent: unknown[] = []) {
  return { write: (frame: unknown) => sent.push(frame),
    onConnect: () => {}, onClose: (_code: number) => {},
    setOnConnect(fn: () => void) { this.onConnect = fn; },
    setOnData(_fn: unknown) {},
    setOnClose(fn: (code: number) => void) { this.onClose = fn; } };
}

function setup(desktopVersion = "4.23118.0", hashSource = () => hash) {
  let compiled = "";
  const prototype = { _compile(contents: string, _filename: string) { compiled = contents; } };
  let received: any;
  const adapter = installSessionStatsAdapter({ desktopVersion, modulePrototype: prototype, hashSource,
    answer: (request, context) => { received = { request, context }; return undefined; } });
  return { adapter, prototype, compiled: () => compiled, received: () => received };
}

test("injects only the verified native callsite and binds the native session/cancellation/write guard", () => {
  const f = setup();
  try {
    f.prototype._compile(fixture, filename);
    assert.notEqual(f.compiled(), fixture);
    const sent: unknown[] = [];
    const sandbox: any = { transport: transport(sent), Symbol };
    const symbol = Symbol.for("claudepp:session-stats:answer");
    sandbox[symbol] = (globalThis as any)[symbol];
    vm.runInNewContext(f.compiled(), sandbox);
    const frame = { request_id: "request-1", request: { subtype: "claudepp_session_stats" } };
    const options = sandbox.fixture.callback(frame);
    options.answerSharedControlRequest(frame.request);
    assert.equal(f.received().context.bridgeSessionId, "cse_abc");
    assert.equal(f.received().context.requestId, "request-1");
    assert.equal(f.received().context.isCurrent(), true);
    options.writeFrame({ ok: 1 });
    f.received().context.canWrite = () => false;
    options.writeFrame({ secret: 2 });
    assert.equal(sent.length, 1);
    sandbox.fixture.replace(transport());
    assert.equal(f.received().context.isCurrent(), false);
    new vm.Script(f.compiled());
  } finally { f.adapter.dispose(); }
});

test("version, path, full hash and exact single callsite drift preserve native source", () => {
  for (const [version, path, source, sha] of [
    ["4.23119.0", filename, fixture, hash],
    ["4.23118.0", "C:/unrelated/index.chunk-DhrjLA58.js", fixture, hash],
    ["4.23118.0", filename, fixture, "bad"],
    ["4.23118.0", filename, "module.exports={};", hash],
    ["4.23118.0", filename, fixture + callsite, hash],
    ["4.23118.0", filename, fixture.replace(connectMarker, "function D(){E.setOnData"), hash],
    ["4.23118.0", filename, fixture.replace(closeMarker, "void 0"), hash],
    ["4.23118.0", filename, fixture + closeMarker, hash],
  ]) {
    const f = setup(version, () => sha);
    try { f.prototype._compile(source, path); assert.equal(f.compiled(), source); }
    finally { f.adapter.dispose(); }
  }
});

test("native close and same-object reconnect invalidate pending responses while fresh requests remain current", () => {
  const f = setup();
  try {
    f.prototype._compile(fixture, filename);
    const native = transport();
    const symbol = Symbol.for("claudepp:session-stats:answer");
    const sandbox: any = { transport: native, Symbol, [symbol]: (globalThis as any)[symbol] };
    vm.runInNewContext(f.compiled(), sandbox);
    native.onConnect();
    const frame = { request_id: "request-1", request: { subtype: "claudepp_session_stats" } };
    sandbox.fixture.callback(frame).answerSharedControlRequest(frame.request);
    const oldContext = f.received().context;
    assert.equal(oldContext.isCurrent(), true);
    native.onClose(1006);
    assert.equal(oldContext.isCurrent(), false);
    native.onConnect();
    assert.equal(oldContext.isCurrent(), false);
    sandbox.fixture.callback({ ...frame, request_id: "request-2" }).answerSharedControlRequest(frame.request);
    assert.equal(f.received().context.isCurrent(), true);
  } finally { f.adapter.dispose(); }
});

test("adapter disposal restores its compile hook and removes its native callback", () => {
  const f = setup();
  f.adapter.dispose();
  f.prototype._compile(fixture, filename);
  assert.equal(f.compiled(), fixture);
  assert.equal((globalThis as any)[Symbol.for("claudepp:session-stats:answer")], undefined);
});

test("both native adapters load independently in either order before restoring the compile hook", () => {
  const ccrPath = "C:/Claude/resources/app.asar/.vite/build/index.chunk-CUXoxsyW.js";
  const ccrHash = "8a49065ed8437a1e4d91c972524044ad58c73eebcac521729a9bc9d9472fab32";
  const ccrFixture = 'class Host{connect(e,o){let s={};s.transport=o,s.lastSequenceNum=o.getSequenceNum,s.transportConnectedAt=null,o.setOnData((t=>{try{let n=JSON.parse(t);this.handleInboundMessage(e,n)}catch(t){}})),o.setOnClose((t=>{P.info(`${L8} Transport permanently closed for session ${e} code=${t}`);}));}}';
  for (const order of [[[fixture, filename], [ccrFixture, ccrPath]],
    [[ccrFixture, ccrPath], [fixture, filename]]]) {
    const f = setup("4.23118.0", source => source === fixture ? hash : ccrHash);
    try {
      for (const [source, path] of order) {
        f.prototype._compile(source, path);
        assert.notEqual(f.compiled(), source);
        new vm.Script(f.compiled());
      }
      f.prototype._compile(fixture, filename);
      assert.equal(f.compiled(), fixture);
    } finally { f.adapter.dispose(); }
  }
});
