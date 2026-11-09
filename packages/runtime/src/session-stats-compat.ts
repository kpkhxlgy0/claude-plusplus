import { createHash } from "node:crypto";
import Module from "node:module";

export interface NativeSessionStatsContext {
  bridgeSessionId: string;
  organizationId?: string;
  requestId: string;
  cancellableRequests: Map<string, AbortController>;
  isCurrent(): boolean;
  canWrite?: () => boolean;
}

export type SessionStatsControlResult =
  | { subtype: "success"; response: { protocolVersion: 1; snapshot: Record<string, unknown> } }
  | { subtype: "error"; error: string };

export interface SessionStatsAdapterOptions {
  desktopVersion: string;
  answer(request: unknown, context: NativeSessionStatsContext): Promise<SessionStatsControlResult> | undefined;
  modulePrototype?: { _compile(contents: string, filename: string): unknown };
  hashSource?: (contents: string) => string;
}

const nativePath = "/app.asar/.vite/build/index.chunk-DhrjLA58.js";
const nativeHash = "c00b0a0617993d7dca342b94cac1fef4ac667f80f8953700b1d3dc87dd4788d4";
const callbackSymbol = Symbol.for("claudepp:session-stats:answer");
const connectMarker = 'function D(){E.setOnConnect((()=>{B(`[bridge:session] Transport connected session=${t}`)})),E.setOnData';
const connectReplacement = 'function D(){let __claudeppLifetime={closed:false,generation:0};E.setOnConnect((()=>{__claudeppLifetime.closed=false;__claudeppLifetime.generation++;B(`[bridge:session] Transport connected session=${t}`)})),E.setOnData';
const closeMarker = 'E.setOnClose((e=>{T||(B(`[bridge:session] Transport closed session=${t} code=${e}`),v?.(e))}))';
const closeReplacement = 'E.setOnClose((e=>{__claudeppLifetime.closed=true;T||(B(`[bridge:session] Transport closed session=${t} code=${e}`),v?.(e))}))';
const callsite = "e=>zhe(e,{transport:E,sessionId:t,outboundOnly:o,claudeCodeVersion:s,onInterrupt:u,onStopTask:d,onBackgroundTasks:f,getPendingPrompts:()=>[...C.values()],onSetModel:p,onSetMaxThinkingTokens:m,onSetPermissionMode:h,onRenameSession:g,onSideQuestion:_,writeFrame:e=>{T||E.write(e)},cancellableRequests:w})";
const replacement = 'e=>{let __claudeppTransport=E,__claudeppGeneration=__claudeppLifetime.generation,__claudeppContext={bridgeSessionId:t,requestId:e.request_id,cancellableRequests:w,isCurrent:()=>!T&&!__claudeppLifetime.closed&&__claudeppLifetime.generation===__claudeppGeneration&&E===__claudeppTransport};return zhe(e,{transport:E,sessionId:t,outboundOnly:o,claudeCodeVersion:s,onInterrupt:u,onStopTask:d,onBackgroundTasks:f,getPendingPrompts:()=>[...C.values()],onSetModel:p,onSetMaxThinkingTokens:m,onSetPermissionMode:h,onRenameSession:g,onSideQuestion:_,answerSharedControlRequest:r=>globalThis[Symbol.for("claudepp:session-stats:answer")]?.(r,__claudeppContext),writeFrame:e=>{T||__claudeppContext.canWrite?.()===false||E.write(e)},cancellableRequests:w})}';

const ccrPath = "/app.asar/.vite/build/index.chunk-CUXoxsyW.js";
const ccrHash = "8a49065ed8437a1e4d91c972524044ad58c73eebcac521729a9bc9d9472fab32";
const ccrConnectionMarker = "s.transport=o,s.lastSequenceNum=o.getSequenceNum,s.transportConnectedAt=null,o.setOnData((t=>{";
const ccrConnectionReplacement = "let __claudeppClosed=false,__claudeppRequests=new Map;s.transport=o,s.lastSequenceNum=o.getSequenceNum,s.transportConnectedAt=null,o.setOnData((t=>{";
const ccrInboundMarker = "try{let n=JSON.parse(t);this.handleInboundMessage(e,n)}catch(t){";
const ccrInboundReplacement = 'try{let n=JSON.parse(t),__claudeppSecret=s.workSecret;if(globalThis[Symbol.for("claudepp:session-stats:answer")]?.handleFrame?.(n,{bridgeSessionId:e,organizationId:this.orgUuid,cancellableRequests:__claudeppRequests,isCurrent:()=>!__claudeppClosed&&!this.isDisposed&&this.activeSessions.get(e)===s&&s.transport===o&&s.workSecret===__claudeppSecret&&o.isConnectedStatus()},(r,i)=>{s.writeQueue=s.writeQueue.then(async()=>{if(i())await o.write(r)}).catch(()=>{});return s.writeQueue}))return;this.handleInboundMessage(e,n)}catch(t){';
const ccrCloseMarker = 'o.setOnClose((t=>{P.info(`${L8} Transport permanently closed for session ${e} code=${t}`);';
const ccrCloseReplacement = 'o.setOnClose((t=>{__claudeppClosed=true;for(let r of __claudeppRequests.values())r.abort();P.info(`${L8} Transport permanently closed for session ${e} code=${t}`);';
const nativeModules = [
  { path: nativePath, hash: nativeHash, markers: [[connectMarker, connectReplacement],
    [closeMarker, closeReplacement], [callsite, replacement]] },
  { path: ccrPath, hash: ccrHash, markers: [[ccrConnectionMarker, ccrConnectionReplacement],
    [ccrInboundMarker, ccrInboundReplacement], [ccrCloseMarker, ccrCloseReplacement]] },
];

type FrameBinding = Omit<NativeSessionStatsContext, "requestId" | "canWrite">;
type QueueReply = (frame: Record<string, unknown>, canWrite: () => boolean) => Promise<unknown>;

/** Install before Claude's entry is required; never reload an already evaluated native module. */
export function installSessionStatsAdapter(options: SessionStatsAdapterOptions): { dispose(): void } {
  if (options.desktopVersion !== "4.23118.0") return { dispose() {} };
  const target = globalThis as unknown as Record<symbol, unknown>;
  if (target[callbackSymbol] !== undefined) return { dispose() {} };
  const prototype = options.modulePrototype ?? Module.prototype as unknown as NonNullable<
    SessionStatsAdapterOptions["modulePrototype"]
  >;
  const original = prototype._compile;
  const hash = options.hashSource ?? ((contents: string) => createHash("sha256").update(contents).digest("hex"));
  let disposed = false;
  const observed = new Set<string>();
  const cancelled = new WeakSet<AbortController>();
  const answer = Object.assign((request: unknown, context: NativeSessionStatsContext) =>
    options.answer(request, context), {
    handleFrame(frame: unknown, binding: FrameBinding, queueReply: QueueReply): boolean {
      if (disposed || !frame || typeof frame !== "object") return false;
      const input = frame as Record<string, unknown>;
      const requestId = input.request_id;
      const requests = binding.cancellableRequests;
      if (input.type === "control_cancel_request" && typeof requestId === "string") {
        const controller = requests.get(requestId);
        if (!controller) return false;
        cancelled.add(controller);
        controller.abort();
        return true;
      }
      const request = input.request as { subtype?: unknown } | undefined;
      if (input.type !== "control_request" || request?.subtype !== "claudepp_session_stats") return false;
      if (typeof requestId !== "string" || !requestId || requestId.length > 128
        || requests.has(requestId) || requests.size >= 8 || !binding.isCurrent()) return true;
      const context: NativeSessionStatsContext = { ...binding, requestId };
      let result: ReturnType<SessionStatsAdapterOptions["answer"]>;
      try { result = options.answer(request, context); } catch { return true; }
      if (result === undefined) return false;
      const controller = requests.get(requestId) ?? new AbortController();
      requests.set(requestId, controller);
      const canWrite = (): boolean => !disposed && target[callbackSymbol] === answer
        && !cancelled.has(controller) && context.isCurrent() && context.canWrite?.() !== false;
      void Promise.resolve(result).then((response) => {
        if (!canWrite() || requests.has(requestId) && requests.get(requestId) !== controller) return;
        requests.set(requestId, controller);
        return queueReply({ type: "control_response", session_id: binding.bridgeSessionId,
          response: response.subtype === "error"
            ? { subtype: "error", request_id: requestId, error: response.error }
            : { subtype: "success", request_id: requestId, response: response.response } }, canWrite);
      }).catch(() => {}).finally(() => {
        if (requests.get(requestId) === controller) requests.delete(requestId);
      });
      return true;
    },
  });
  const restore = (): void => {
    if (prototype._compile === wrapper) prototype._compile = original;
  };
  const wrapper = function (this: unknown, contents: string, filename: string): unknown {
    const native = nativeModules.find(item => filename.replace(/\\/g, "/").endsWith(item.path));
    if (!disposed && native) {
      observed.add(native.path);
      try {
        if (hash(contents) === native.hash
          && native.markers.every(([marker]) => contents.split(marker).length === 2)) {
          for (const [marker, replacement] of native.markers) contents = contents.replace(marker, replacement);
        }
      } catch { /* A failed compatibility probe leaves the original native module intact. */ }
      if (observed.size === nativeModules.length) restore();
    }
    return Reflect.apply(original, this, [contents, filename]);
  };
  target[callbackSymbol] = answer;
  prototype._compile = wrapper;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      restore();
      if (target[callbackSymbol] === answer) delete target[callbackSymbol];
    },
  };
}
