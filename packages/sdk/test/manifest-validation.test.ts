import assert from "node:assert/strict";
import test from "node:test";
import {
  defineTweak,
  VALID_TWEAK_PERMISSIONS,
  validateTweakManifest,
  type SettingsApi,
  type SettingsHandle,
  type SettingsPage,
  type SettingsSection,
  type TweakApi,
  type TweakFs,
  type TweakIpc,
  type TweakStorage,
} from "../src/index.ts";

test("accepts an explicit renderer manifest with generic permissions", () => {
  const result = validateTweakManifest({
    id: "com.claudeplusplus.probe",
    name: "Claude++ Probe",
    version: "0.2.0",
    githubRepo: "example/claudeplusplus-probe",
    scope: "renderer",
    main: "index.js",
    permissions: ["settings", "ipc"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("accepts complete Tweak metadata and generic permissions", () => {
  for (const author of [
    "Example Author",
    { name: "Example Author", url: "https://example.com", email: "author@example.com" },
  ]) {
    const result = validateTweakManifest({
      id: "com.example.complete-tweak",
      name: "Complete Example Tweak",
      version: "0.2.0",
      githubRepo: "example/complete-tweak",
      description: "Demonstrates every supported manifest field.",
      author,
      homepage: "https://example.com/complete-tweak",
      iconUrl: "./icon.png",
      tags: ["example", "workflow", "settings"],
      minRuntime: "0.2.0",
      scope: "both",
      main: "index.js",
      permissions: [
        "settings",
        "ipc",
        "filesystem",
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  }
});

test("rejects malformed optional metadata", () => {
  const cases = [
    [{ author: 42 }, "author"],
    [{ author: { name: "" } }, "author.name"],
    [{ homepage: 42 }, "homepage"],
    [{ iconUrl: 42 }, "iconUrl"],
    [{ tags: ["example", 42] }, "tags"],
    [{ minRuntime: ">=0.2.0" }, "minRuntime"],
  ] as const;

  for (const [metadata, expectedPath] of cases) {
    const result = validateTweakManifest({
      id: "com.claudeplusplus.invalid-metadata",
      name: "Invalid metadata",
      version: "0.2.0",
      githubRepo: "example/invalid-metadata",
      scope: "renderer",
      ...metadata,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.path === expectedPath), true);
  }
});

test("treats omitted scope as both with a warning", () => {
  const result = validateTweakManifest({
    id: "com.claudeplusplus.probe",
    name: "Claude++ Probe",
    version: "0.2.0",
    githubRepo: "example/claudeplusplus-probe",
  });

  assert.equal(result.ok, true);
  assert.match(result.warnings[0]?.message ?? "", /scope.*both/i);
});

test("rejects Codex-only permissions", () => {
  const result = validateTweakManifest({
    id: "com.claudeplusplus.bad",
    name: "Bad",
    version: "0.2.0",
    githubRepo: "example/bad",
    permissions: ["codex-runtime"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.path, "permissions[0]");
});

test("exposes only generic permissions and rejects former private permissions", () => {
  assert.deepEqual(VALID_TWEAK_PERMISSIONS, [
    "ipc",
    "filesystem",
    "network",
    "settings",
  ]);

  for (const permission of [
    "claude-runtime",
    "claude-composer",
    "claude-sessions-start",
    "claude-sessions-navigate",
    "claude-sessions-configure",
    "claude-workspace-trust",
    "protocol-handler",
    "mcp-session",
    "mcp-global-sync",
  ]) {
    const result = validateTweakManifest({
      id: "com.claudeplusplus.private-permission",
      name: "Private permission",
      version: "0.2.0",
      githubRepo: "example/private-permission",
      scope: "renderer",
      permissions: [permission],
    });

    assert.equal(result.ok, false, permission);
    assert.equal(result.errors[0]?.path, "permissions[0]", permission);
  }
});

test("defineTweak preserves the lifecycle object", () => {
  const tweak = {
    start() {},
    stop() {},
  };

  assert.equal(defineTweak(tweak), tweak);
});

test("public API contracts support an isolated host-neutral tweak", () => {
  const values = new Map<string, unknown>();
  const storage: TweakStorage = {
    get<T = unknown>(key: string, fallback?: T): T {
      return (values.has(key) ? values.get(key) : fallback) as T;
    },
    set(key: string, value: unknown): void {
      values.set(key, value);
    },
    delete(key: string): void {
      values.delete(key);
    },
    all(): Record<string, unknown> {
      return Object.fromEntries(values);
    },
  };
  const ipc: TweakIpc = {
    on(): () => void {
      return () => {};
    },
    send(): void {},
    async invoke<T = unknown>(): Promise<T> {
      return undefined as T;
    },
    handle(): void {},
  };
  const fs: TweakFs = {
    dataDir: "C:\\ClaudePlusPlus\\data",
    async read(): Promise<string> {
      return "";
    },
    async write(): Promise<void> {},
    async exists(): Promise<boolean> {
      return false;
    },
  };
  const handle: SettingsHandle = { unregister(): void {} };
  const section: SettingsSection = {
    id: "general",
    title: "General",
    render(): void {},
  };
  const page: SettingsPage = {
    id: "example",
    title: "Example",
    iconSvg: "<svg></svg>",
    render(): () => void {
      return () => {};
    },
  };
  const settings: SettingsApi = {
    register(value): SettingsHandle {
      assert.equal(value, section);
      return handle;
    },
    registerPage(value): SettingsHandle {
      assert.equal(value, page);
      return handle;
    },
  };
  const api: TweakApi = {
    manifest: {
      id: "com.example.complete-tweak",
      name: "Complete Example Tweak",
      version: "0.2.0",
      githubRepo: "example/complete-tweak",
    },
    storage,
    log: {
      debug(..._args: unknown[]): void {},
      info(..._args: unknown[]): void {},
      warn(..._args: unknown[]): void {},
      error(..._args: unknown[]): void {},
    },
    process: "renderer",
    settings,
    ipc,
    fs,
  };

  storage.set("enabled", true);
  assert.equal(storage.get("enabled", false), true);
  assert.equal(api.settings?.register(section), handle);
  assert.equal(api.settings?.registerPage(page), handle);
  assert.equal("claude" in api, false);
});
