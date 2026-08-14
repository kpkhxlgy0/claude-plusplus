# Renderer Tweak CSP Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Claude++ Renderer Tweak evaluation on current Claude Desktop by adding `'unsafe-eval'` only to qualifying managed Claude `app:` main-document CSP headers while preserving junction-backed Tweak hot reload.

**Architecture:** Add a focused, pure CSP compatibility module beside the runtime bootstrap, then install one Electron `webRequest.onHeadersReceived` listener per Session together with the existing preload registration. The listener gates on `resourceType === "mainFrame"`, parses the request URL as `app:`, transforms only `Content-Security-Policy` response values that already contain `script-src`, and otherwise returns the response untouched. Existing Renderer evaluation, lifecycle reconstruction, Tweak watcher, Unity Links submodule, and junction remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner, Electron 41 Session/WebRequest APIs, npm workspaces, esbuild.

## Global Constraints

- Work in `D:\Unity\ClaudePlusPlus`; do not edit the installed runtime under `%APPDATA%` directly.
- Treat installed Codex++ 1.0.0 as the architecture reference; the approved divergence is only Claude-host CSP compatibility.
- Preserve `sandbox=true`, `contextIsolation=true`, the `new Function` Renderer Tweak ABI, API leases, lifecycle cleanup, and automatic reconstruction.
- Add only `'unsafe-eval'`; never add `'unsafe-inline'`, remove existing CSP sources, or modify another directive.
- Modify only `app:` top-level document response headers. Leave HTTP, HTTPS, authentication, DevTools, iframe, script, image, API, and extension responses unchanged.
- If a CSP has no `script-src`, or cannot be interpreted safely, return it unchanged.
- Do not rewrite Claude HTML or CSP `<meta>` elements in this change.
- The Unity Links aggregate repository is `D:\workspace\sgproj\FilePackages\unity-links`; its Claude Tweak is the `claude-tweak` submodule.
- The installed junction `%APPDATA%\claude-plusplus\tweaks\com.kpk.unity-asset-links` must continue targeting `D:\workspace\sgproj\FilePackages\unity-links\claude-tweak`.
- Do not edit or advance any Unity Links submodule pin for this fix.
- Do not commit unless the user explicitly authorizes commits.

---

## File Structure

- Create `packages/runtime/src/renderer-tweak-csp.ts`: pure CSP value transformation, Electron request gating, and per-Session listener installation.
- Create `packages/runtime/test/renderer-tweak-csp.test.ts`: table-driven unit tests for parsing boundaries, idempotence, response gating, and one-listener-per-Session behavior.
- Modify `packages/runtime/src/main.ts`: install the CSP compatibility listener at the same Session registration boundary as the Renderer preload.
- Modify `packages/runtime/test/main.test.ts`: extend the fake Electron Session and prove default and later-created Sessions receive both preload and CSP registration exactly once.
- Keep `packages/runtime/src/preload/tweak-host.ts` unchanged: it remains the source-string evaluator and hot-reload consumer.
- Keep `D:\workspace\sgproj\FilePackages\unity-links\claude-tweak\index.js` unchanged except for a temporary behavior-neutral edit during manual hot-reload verification, restored before completion.

### Task 1: Pure CSP Compatibility and Session Hook

**Files:**
- Create: `packages/runtime/src/renderer-tweak-csp.ts`
- Create: `packages/runtime/test/renderer-tweak-csp.test.ts`

**Interfaces:**
- Produces: `addUnsafeEvalToScriptSrc(policy: string): CspTransformResult`
- Produces: `shouldRelaxRendererTweakCsp(details: Pick<Electron.OnHeadersReceivedListenerDetails, "url" | "resourceType">): boolean`
- Produces: `installRendererTweakCspCompatibility(session: Electron.Session, log: TweakLogger): void`
- `CspTransformResult` is `{ policy: string; changed: boolean; reason: "changed" | "alreadyAllowed" | "scriptSrcMissing" | "malformed" }`.
- Later tasks consume only `installRendererTweakCspCompatibility` from `main.ts`; the pure helpers remain exported for direct tests.

- [ ] **Step 1: Write failing pure transformation tests**

Create `packages/runtime/test/renderer-tweak-csp.test.ts` with the initial cases:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  addUnsafeEvalToScriptSrc,
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
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && node --import tsx --test packages/runtime/test/renderer-tweak-csp.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `packages/runtime/src/renderer-tweak-csp.ts`.

- [ ] **Step 3: Implement the minimal pure transformer and request gate**

Create `packages/runtime/src/renderer-tweak-csp.ts` with:

```ts
import type { TweakLogger } from "@claude-plusplus/sdk";

export interface CspTransformResult {
  policy: string;
  changed: boolean;
  reason: "changed" | "alreadyAllowed" | "scriptSrcMissing" | "malformed";
}

const installedSessions = new WeakSet<Electron.Session>();

export function addUnsafeEvalToScriptSrc(policy: string): CspTransformResult {
  const parts = policy.split(";");
  let scriptSrcIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const directive = parts[index]?.trim();
    if (!directive) continue;
    const [name] = directive.split(/\s+/, 1);
    if (name?.toLowerCase() === "script-src") {
      if (scriptSrcIndex >= 0) {
        return { policy, changed: false, reason: "malformed" };
      }
      scriptSrcIndex = index;
    }
  }
  if (scriptSrcIndex < 0) {
    return { policy, changed: false, reason: "scriptSrcMissing" };
  }

  const original = parts[scriptSrcIndex]?.trim() ?? "";
  const [name, ...sources] = original.split(/\s+/);
  if (!name || sources.length === 0) {
    return { policy, changed: false, reason: "malformed" };
  }
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
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!shouldRelaxRendererTweakCsp(details) || !details.responseHeaders) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const responseHeaders = { ...details.responseHeaders };
    const key = Object.keys(responseHeaders).find(
      (name) => name.toLowerCase() === "content-security-policy",
    );
    if (!key) {
      callback({ responseHeaders });
      return;
    }

    let changed = false;
    responseHeaders[key] = responseHeaders[key]?.map((policy) => {
      const result = addUnsafeEvalToScriptSrc(policy);
      changed ||= result.changed;
      if (result.reason === "malformed") {
        log.warn("Renderer Tweak CSP policy was left unchanged because it is malformed");
      }
      return result.policy;
    });
    if (changed) log.info("Enabled Renderer Tweak evaluation for managed Claude app document");
    callback({ responseHeaders });
  });
  installedSessions.add(session);
  log.info("Installed Renderer Tweak CSP compatibility hook");
}
```

Implementation note: if TypeScript reports the listener detail type under a different Electron namespace alias, use the exact exported Electron 41 type shown by the compiler; do not broaden the parameter to `any`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && node --import tsx --test packages/runtime/test/renderer-tweak-csp.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Add failing listener tests for headers, multiple values, and registration idempotence**

Append to `packages/runtime/test/renderer-tweak-csp.test.ts`:

```ts
import { installRendererTweakCspCompatibility } from "../src/renderer-tweak-csp.ts";

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
```

- [ ] **Step 6: Run the listener tests and adjust only compiler-discovered Electron type names**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && npm run build --workspace @claude-plusplus/runtime
```

Expected before any type-name adjustment: either PASS, or a TypeScript error naming the exact Electron 41 listener/response type. If an error names a replacement type, update only the affected annotations and rerun. Expected final result: runtime build exits 0.

- [ ] **Step 7: Run the complete focused test file**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && node --import tsx --test packages/runtime/test/renderer-tweak-csp.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 8: Record a review checkpoint without committing**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && git diff -- packages/runtime/src/renderer-tweak-csp.ts packages/runtime/test/renderer-tweak-csp.test.ts
```

Expected: only the focused CSP module and its tests appear. Do not commit without explicit user authorization.

### Task 2: Wire the Compatibility Hook into Runtime Session Registration

**Files:**
- Modify: `packages/runtime/src/main.ts:1-75`
- Modify: `packages/runtime/test/main.test.ts:55-178,396-428`

**Interfaces:**
- Consumes: `installRendererTweakCspCompatibility(session: Electron.Session, log: TweakLogger): void` from Task 1.
- Produces: every default and later-created Electron Session gets one preload registration and one CSP compatibility listener registration.
- Does not change `bootstrapRuntime`'s public signature.

- [ ] **Step 1: Extend the fake Electron Session and write failing integration assertions**

In `packages/runtime/test/main.test.ts`, add a small helper before `fakeElectron`:

```ts
function fakeSession(
  registerPreloadScript: (options: unknown) => string = () => "claude-plusplus",
  onHeadersReceived: (listener: unknown) => void = () => {},
): Record<string, unknown> {
  return {
    registerPreloadScript,
    webRequest: { onHeadersReceived },
  };
}
```

Replace test-only Session literals that are passed through runtime registration with `fakeSession(...)`. For example, change the modern preload test setup to:

```ts
const electron = fakeElectron(fakeSession((options) => {
  registrations.push(options);
  return "claude-plusplus";
}));
```

Add this test after the existing default-Session idempotence test:

```ts
test("registers Renderer preload and CSP compatibility once per Session", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudepp-runtime-session-csp-"));
  try {
    let sessionCreated: ((session: Record<string, unknown>) => void) | undefined;
    let defaultPreloads = 0;
    let defaultCspHooks = 0;
    let laterPreloads = 0;
    let laterCspHooks = 0;
    const defaultSession = fakeSession(
      () => { defaultPreloads += 1; return "claude-plusplus"; },
      () => { defaultCspHooks += 1; },
    );
    const laterSession = fakeSession(
      () => { laterPreloads += 1; return "claude-plusplus-later"; },
      () => { laterCspHooks += 1; },
    );
    const electron = fakeElectron(defaultSession, (listener) => { sessionCreated = listener; });
    electron.app.whenReady = async () => { sessionCreated?.(defaultSession); };

    await bootstrapRuntime({ electron, userRoot: root, preloadPath: "C:\\runtime\\preload.js" });
    sessionCreated?.(laterSession);
    sessionCreated?.(laterSession);

    assert.deepEqual(
      { defaultPreloads, defaultCspHooks, laterPreloads, laterCspHooks },
      { defaultPreloads: 1, defaultCspHooks: 1, laterPreloads: 1, laterCspHooks: 1 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Update every existing fake default Session used by `bootstrapRuntime` to expose `webRequest.onHeadersReceived`; do not make production code silently skip Sessions without WebRequest.

- [ ] **Step 2: Run the runtime main tests and verify the new assertion fails**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && node --import tsx --test packages/runtime/test/main.test.ts
```

Expected: FAIL because `defaultCspHooks` and `laterCspHooks` remain `0`.

- [ ] **Step 3: Install the compatibility hook at the existing Session boundary**

Modify `packages/runtime/src/main.ts` imports:

```ts
import { installRendererTweakCspCompatibility } from "./renderer-tweak-csp.js";
```

Replace the current Session `register` body with:

```ts
const registeredSessions = new WeakSet<Electron.Session>();
const register = (session: Electron.Session) => {
  if (registeredSessions.has(session)) return;
  installRendererTweakCspCompatibility(session, log);
  registerPreload(session, deps.preloadPath, log);
  registeredSessions.add(session);
};
```

Install CSP compatibility before the preload so the page's first document response is covered before Renderer Tweak evaluation begins. Keep the existing `session-created`, `ready`, `whenReady`, and default Session ordering unchanged.

- [ ] **Step 4: Run runtime main tests and verify they pass**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && node --import tsx --test packages/runtime/test/main.test.ts
```

Expected: all tests PASS, including the new one-listener-per-Session assertion.

- [ ] **Step 5: Run the runtime build and focused Renderer lifecycle tests**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && npm run build --workspace @claude-plusplus/runtime
```

Expected: exit 0.

Run:

```bash
cd /d/Unity/ClaudePlusPlus && node --import tsx --test packages/runtime/test/renderer-host.test.ts packages/runtime/test/preload-sandbox.test.mjs
```

Expected: all Renderer evaluator, API lease, reconstruction, and sandbox tests PASS. No test should require changing `tweak-host.ts`.

- [ ] **Step 6: Confirm the approved scope in the diff**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && git diff --stat
```

Expected changed paths:

```text
packages/runtime/src/main.ts
packages/runtime/src/renderer-tweak-csp.ts
packages/runtime/test/main.test.ts
packages/runtime/test/renderer-tweak-csp.test.ts
docs/superpowers/specs/2026-08-14-renderer-tweak-csp-compatibility-design.md
docs/superpowers/plans/2026-08-14-renderer-tweak-csp-compatibility.md
```

No Unity Links source, submodule pointer, installed `%APPDATA%` runtime, or generated `runtime/*.js` path should appear. Do not commit without explicit user authorization.

### Task 3: Full Verification, Installation, Hot Reload, and Unity Link Smoke Test

**Files:**
- Verify only: all changed Claude++ files from Tasks 1-2.
- Temporarily touch then restore: `D:\workspace\sgproj\FilePackages\unity-links\claude-tweak\index.js`
- Do not retain changes in `D:\workspace\sgproj\FilePackages\unity-links` or any submodule.

**Interfaces:**
- Consumes: built Claude++ runtime with bounded CSP compatibility.
- Consumes: existing Unity Links `scope: "both"` Tweak and named-pipe Unity package.
- Produces: evidence that tests pass, installed Renderer Tweak starts, junction-backed changes hot reload, and an eligible asset link reaches Unity.

- [ ] **Step 1: Run the complete Claude++ test suite**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && npm test
```

Expected: build succeeds and every repository test passes. If any unrelated pre-existing test fails, preserve the exact failure output and stop before installation.

- [ ] **Step 2: Verify repository and submodule state before installation**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && git status --short
```

Expected: only the six approved Claude++ files are changed/new.

Run:

```bash
cd /d/workspace/sgproj/FilePackages/unity-links && git status --short --branch && git submodule status
```

Expected: aggregate repository and all three submodules are clean; `claude-tweak` remains at `5869aa8c4740b7f61ce0aef92e513290fced5624` unless the user independently changed it after this plan was written.

Run:

```bash
pwsh -NoProfile -Command '$item = Get-Item -LiteralPath "$env:APPDATA\claude-plusplus\tweaks\com.kpk.unity-asset-links" -Force; [pscustomobject]@{ LinkType = $item.LinkType; Target = @($item.Target) } | ConvertTo-Json -Depth 3'
```

Expected: `LinkType` is `Junction` and target is exactly `D:\workspace\sgproj\FilePackages\unity-links\claude-tweak`.

- [ ] **Step 3: Build the Windows package**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && npm run package:windows
```

Expected: exit 0 and a Windows release package is produced at the path printed by the packaging script.

- [ ] **Step 4: Install into the managed Claude mirror**

This changes application state and requires Claude Desktop to be closed. Use the generated release's `install.ps1`, not direct edits under `%APPDATA%` or the managed app mirror:

```bash
pwsh -NoProfile -File <generated-release-directory>/install.ps1
```

Expected: install succeeds, updates Claude++ state to the built runtime, and does not modify the Unity Links junction target. Replace `<generated-release-directory>` with the exact path printed by Step 3; do not guess it.

- [ ] **Step 5: Restart managed Claude and verify Renderer Tweak loading**

Launch Claude through the managed Claude++ entry, then inspect:

```bash
python -c "from pathlib import Path; p=Path.home()/'AppData/Roaming/claude-plusplus/log/renderer.log'; print(p.read_text(encoding='utf-8', errors='replace'))"
```

Expected in the latest startup section:

- `Renderer Tweak discovery started`
- `Renderer Tweaks started`
- no `com.kpk.unity-asset-links failed to evaluate`
- no `unsafe-eval is not an allowed source`

Inspect Main diagnostics similarly:

```bash
python -c "from pathlib import Path; p=Path.home()/'AppData/Roaming/claude-plusplus/log/main.log'; print(p.read_text(encoding='utf-8', errors='replace'))"
```

Expected in the latest startup section:

- `Installed Renderer Tweak CSP compatibility hook`
- `Enabled Renderer Tweak evaluation for managed Claude app document`
- `sandbox=true contextIsolation=true`

If the compatibility hook installs but no policy is changed and Renderer still reports CSP failure, stop. This indicates the effective policy is not a qualifying response header, and the approved scope does not authorize HTML/meta rewriting.

- [ ] **Step 6: Verify junction-backed automatic hot reload without retaining a Tweak change**

Record the current SHA-256 of the submodule file:

```bash
cd /d/workspace/sgproj/FilePackages/unity-links/claude-tweak && git hash-object index.js
```

Expected: one blob hash; save it for comparison.

Append one blank line to `index.js`, wait for Claude++ to log `reloading Tweaks`, then restore the file immediately:

```bash
cd /d/workspace/sgproj/FilePackages/unity-links/claude-tweak && printf '\n' >> index.js && sleep 2 && git checkout -- index.js
```

Expected:

- `main.log` records `reloading Tweaks` for the junction-backed `claude-tweak/index.js` path.
- `renderer.log` records reconstruction without an evaluation failure.
- The restore triggers a second reload.

Confirm restoration:

```bash
cd /d/workspace/sgproj/FilePackages/unity-links/claude-tweak && git status --short && git hash-object index.js
```

Expected: empty status and the original blob hash. If the file was not clean before this step, do not use `git checkout`; stop and preserve the user's changes.

- [ ] **Step 7: Verify the matching Unity Editor and click behavior**

Read `mcpforunity://instances` and confirm one running instance named `sgproj` points to `D:/workspace/sgproj/Assets`.

In the Claude conversation, click these ordinary local links with an unmodified left click:

```markdown
[GameEntry.cs line 1](D:/workspace/sgproj/Assets/GameEntry.cs:1)
[GameEntry scene](D:/workspace/sgproj/Assets/Scenes/GameEntry.unity)
[Waiting prefab](D:/workspace/sgproj/Assets/UI/Prefabs/UI_Tips/Form_Waiting.prefab)
```

Expected:

- The C# file opens through Unity's asset handling with line `1` propagated.
- The scene and prefab open or select through Unity `AssetDatabase.OpenAsset` behavior.
- No Unity-unavailable notice appears while the matching Editor receiver is running.

Then Ctrl-click one link and click one `https:` link. Expected: Unity Links does not intercept either action and Claude retains its original behavior.

- [ ] **Step 8: Run final state checks and report evidence**

Run:

```bash
cd /d/Unity/ClaudePlusPlus && git status --short
```

Expected: only the approved Claude++ source, tests, spec, and plan remain changed/new.

Run:

```bash
cd /d/workspace/sgproj/FilePackages/unity-links && git status --short --branch && git submodule status
```

Expected: no Unity Links or submodule working-tree changes and no submodule pointer changes.

Final report must include:

- complete `npm test` result;
- CSP hook and Renderer Tweak startup evidence from the latest logs;
- hot-reload evidence and confirmation that `claude-tweak/index.js` was restored;
- Unity click-test outcomes for script, scene, prefab, modified click, and web link;
- exact remaining Claude++ changed-file list;
- explicit statement that no commit was created unless the user separately authorized one.
