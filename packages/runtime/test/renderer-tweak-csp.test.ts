import assert from "node:assert/strict";
import test from "node:test";
import {
  addUnsafeEvalToScriptSrc,
  installRendererTweakCspCompatibility,
  shouldRelaxRendererTweakCsp,
} from "../src/renderer-tweak-csp.ts";

test("adds unsafe-eval to script-src without changing other directives", () => {
  const input = "default-src 'self'; script-src 'self' https://chrome-devtools-frontend.appspot.com; object-src 'none'";

  assert.deepEqual(addUnsafeEvalToScriptSrc(input), {
    policy: "default-src 'self'; script-src 'self' 'unsafe-eval' https://chrome-devtools-frontend.appspot.com; object-src 'none'",
    changed: true,
    reason: "changed",
  });
});

test("does not add unsafe-eval twice", () => {
  const input = "script-src 'self' 'unsafe-eval' https://chrome-devtools-frontend.appspot.com; object-src 'none'";

  assert.deepEqual(addUnsafeEvalToScriptSrc(input), {
    policy: input,
    changed: false,
    reason: "alreadyAllowed",
  });
});

test("leaves policies without script-src unchanged", () => {
  const input = "default-src 'self'; object-src 'none'";

  assert.deepEqual(addUnsafeEvalToScriptSrc(input), {
    policy: input,
    changed: false,
    reason: "scriptSrcMissing",
  });
});

test("only accepts app main-frame requests", () => {
  assert.equal(shouldRelaxRendererTweakCsp({ url: "app://-/index.html", resourceType: "mainFrame" }), true);
  assert.equal(shouldRelaxRendererTweakCsp({ url: "https://claude.ai/", resourceType: "mainFrame" }), false);
  assert.equal(shouldRelaxRendererTweakCsp({ url: "app://-/bundle.js", resourceType: "script" }), false);
  assert.equal(shouldRelaxRendererTweakCsp({ url: "not a url", resourceType: "mainFrame" }), false);
});

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test("rewrites every CSP value and preserves header casing and unrelated headers", () => {
  let listener: Electron.OnHeadersReceivedListener | undefined;
  const session = {
    webRequest: {
      onHeadersReceived(value: Electron.OnHeadersReceivedListener) {
        listener = value;
      },
    },
  } as unknown as Electron.Session;
  installRendererTweakCspCompatibility(session, logger());

  let result: Electron.HeadersReceivedResponse | undefined;
  listener?.({
    url: "app://-/index.html",
    resourceType: "mainFrame",
    responseHeaders: {
      "Content-Security-Policy": [
        "script-src 'self'; object-src 'none'",
        "default-src 'self'; script-src https://example.invalid",
      ],
      "X-Test": ["preserved"],
    },
  } as Electron.OnHeadersReceivedListenerDetails, (value) => { result = value; });

  assert.deepEqual(result?.responseHeaders, {
    "Content-Security-Policy": [
      "script-src 'self' 'unsafe-eval'; object-src 'none'",
      "default-src 'self'; script-src 'unsafe-eval' https://example.invalid",
    ],
    "X-Test": ["preserved"],
  });
});

test("passes non-app responses through without modification", () => {
  let listener: Electron.OnHeadersReceivedListener | undefined;
  const headers = { "Content-Security-Policy": ["script-src 'self'"] };
  const session = {
    webRequest: {
      onHeadersReceived(value: Electron.OnHeadersReceivedListener) {
        listener = value;
      },
    },
  } as unknown as Electron.Session;
  installRendererTweakCspCompatibility(session, logger());

  let result: Electron.HeadersReceivedResponse | undefined;
  listener?.({
    url: "https://claude.ai/",
    resourceType: "mainFrame",
    responseHeaders: headers,
  } as Electron.OnHeadersReceivedListenerDetails, (value) => { result = value; });

  assert.equal(result?.responseHeaders, headers);
});

test("registers one listener per Session", () => {
  let count = 0;
  const session = {
    webRequest: {
      onHeadersReceived() { count += 1; },
    },
  } as unknown as Electron.Session;

  installRendererTweakCspCompatibility(session, logger());
  installRendererTweakCspCompatibility(session, logger());

  assert.equal(count, 1);
});

test("composes a later current-Claude headers listener with CSP compatibility", () => {
  let activeListener: Electron.OnHeadersReceivedListener | undefined;
  const webRequest = {
    onHeadersReceived(value: Electron.OnHeadersReceivedListener) {
      activeListener = value;
    },
  };
  const session = { webRequest } as unknown as Electron.Session;
  installRendererTweakCspCompatibility(session, logger());

  webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Document-Policy": ["js-profiling"],
      },
    });
  });

  let result: Electron.HeadersReceivedResponse | undefined;
  activeListener?.({
    url: "app://-/index.html",
    resourceType: "mainFrame",
    responseHeaders: {
      "Content-Security-Policy": ["script-src 'self'; object-src 'none'"],
    },
  } as Electron.OnHeadersReceivedListenerDetails, (value) => { result = value; });

  assert.deepEqual(result?.responseHeaders, {
    "Content-Security-Policy": ["script-src 'self' 'unsafe-eval'; object-src 'none'"],
    "Document-Policy": ["js-profiling"],
  });
});

test("completes a composed headers request only once", () => {
  let activeListener: Electron.OnHeadersReceivedListener | undefined;
  const webRequest = {
    onHeadersReceived(value: Electron.OnHeadersReceivedListener) {
      activeListener = value;
    },
  };
  const session = { webRequest } as unknown as Electron.Session;
  installRendererTweakCspCompatibility(session, logger());
  webRequest.onHeadersReceived((_details, callback) => {
    callback({ responseHeaders: { "X-Test": ["first"] } });
    callback({ responseHeaders: { "X-Test": ["second"] } });
  });

  const results: Electron.HeadersReceivedResponse[] = [];
  activeListener?.({
    url: "app://-/index.html",
    resourceType: "mainFrame",
    responseHeaders: {},
  } as Electron.OnHeadersReceivedListenerDetails, (value) => { results.push(value); });

  assert.deepEqual(results, [{ responseHeaders: { "X-Test": ["first"] } }]);
});
