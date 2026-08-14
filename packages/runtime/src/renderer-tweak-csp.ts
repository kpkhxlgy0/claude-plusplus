import type { TweakLogger } from "@claude-plusplus/sdk";

export interface CspTransformResult {
  policy: string;
  changed: boolean;
  reason: "changed" | "alreadyAllowed" | "scriptSrcMissing" | "malformed";
}

const installedSessions = new WeakSet<Electron.Session>();

type HeadersListener = (
  details: Electron.OnHeadersReceivedListenerDetails,
  callback: (response: Electron.HeadersReceivedResponse) => void,
) => void;
type HeadersRegistrar = {
  (listener: HeadersListener | null): void;
  (filter: Electron.WebRequestFilter, listener: HeadersListener | null): void;
};

export function addUnsafeEvalToScriptSrc(policy: string): CspTransformResult {
  const parts = policy.split(";");
  let scriptSrcIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const directive = parts[index]?.trim();
    if (!directive) continue;
    const [name] = directive.split(/\s+/, 1);
    if (name?.toLowerCase() !== "script-src") continue;
    if (scriptSrcIndex >= 0) return { policy, changed: false, reason: "malformed" };
    scriptSrcIndex = index;
  }
  if (scriptSrcIndex < 0) return { policy, changed: false, reason: "scriptSrcMissing" };

  const original = parts[scriptSrcIndex]?.trim() ?? "";
  const [name, ...sources] = original.split(/\s+/);
  if (!name || sources.length === 0) return { policy, changed: false, reason: "malformed" };
  if (sources.some((source) => source.toLowerCase() === "'unsafe-eval'")) {
    return { policy, changed: false, reason: "alreadyAllowed" };
  }

  const selfIndex = sources.findIndex((source) => source.toLowerCase() === "'self'");
  sources.splice(selfIndex >= 0 ? selfIndex + 1 : 0, 0, "'unsafe-eval'");
  parts[scriptSrcIndex] = `${name} ${sources.join(" ")}`;
  return {
    policy: parts.map((part) => part.trim()).filter(Boolean).join("; "),
    changed: true,
    reason: "changed",
  };
}

export function shouldRelaxRendererTweakCsp(
  details: Pick<Electron.OnHeadersReceivedListenerDetails, "url" | "resourceType">,
): boolean {
  if (details.resourceType !== "mainFrame") return false;
  try {
    return new URL(details.url).protocol === "app:";
  } catch {
    return false;
  }
}

export function installRendererTweakCspCompatibility(
  session: Electron.Session,
  log: TweakLogger,
): void {
  if (installedSessions.has(session)) return;
  const webRequest = session.webRequest;
  const register = webRequest.onHeadersReceived.bind(webRequest) as HeadersRegistrar;
  let hostListener: HeadersListener | null = null;
  const combinedListener: HeadersListener = (details, callback) => {
    let completed = false;
    const complete = (response: Electron.HeadersReceivedResponse): void => {
      if (completed) return;
      completed = true;
      callback(transformResponse(details, response, log));
    };
    if (!hostListener) {
      complete({ responseHeaders: details.responseHeaders });
      return;
    }
    try {
      hostListener(details, complete);
    } catch (error) {
      if (completed) return;
      completed = true;
      log.error(`Claude headers listener failed: ${errorMessage(error)}`);
      callback({ responseHeaders: details.responseHeaders });
    }
  };
  const wrappedRegister = ((...args: unknown[]): void => {
    if (args.length === 1 && (typeof args[0] === "function" || args[0] === null)) {
      hostListener = args[0] as HeadersListener | null;
      register(combinedListener);
      return;
    }
    log.warn("Renderer Tweak CSP compatibility was disabled by an unsupported filtered headers listener");
    (register as (...values: unknown[]) => void)(...args);
  }) as HeadersRegistrar;
  webRequest.onHeadersReceived = wrappedRegister;
  register(combinedListener);
  installedSessions.add(session);
  log.info("Installed Renderer Tweak CSP compatibility hook");
}

function transformResponse(
  details: Electron.OnHeadersReceivedListenerDetails,
  response: Electron.HeadersReceivedResponse,
  log: TweakLogger,
): Electron.HeadersReceivedResponse {
  const sourceHeaders = response.responseHeaders ?? details.responseHeaders;
  if (!shouldRelaxRendererTweakCsp(details) || !sourceHeaders) return response;

  const responseHeaders = { ...sourceHeaders };
  const key = Object.keys(responseHeaders).find(
    (name) => name.toLowerCase() === "content-security-policy",
  );
  if (!key) return { ...response, responseHeaders };

  let changed = false;
  const originalPolicies = responseHeaders[key];
  if (!originalPolicies) return { ...response, responseHeaders };
  const policies = Array.isArray(originalPolicies) ? originalPolicies : [originalPolicies];
  const transformedPolicies = policies.map((policy) => {
    const result = addUnsafeEvalToScriptSrc(policy);
    changed ||= result.changed;
    if (result.reason === "malformed") {
      log.warn("Renderer Tweak CSP policy was left unchanged because it is malformed");
    }
    return result.policy;
  });
  responseHeaders[key] = Array.isArray(originalPolicies)
    ? transformedPolicies
    : transformedPolicies[0] ?? originalPolicies;
  if (changed) log.info("Enabled Renderer Tweak evaluation for managed Claude app document");
  return { ...response, responseHeaders };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
