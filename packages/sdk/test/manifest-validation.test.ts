import assert from "node:assert/strict";
import test from "node:test";
import {
  defineTweak,
  VALID_TWEAK_PERMISSIONS,
  validateTweakManifest,
  type ClaudeApi,
  type ClaudeCodeSettingsApi,
  type ClaudeSessionTitlesApi,
  type ClaudeSessionTitleUpdate,
  type SettingsApi,
  type SettingsHandle,
  type SettingsPage,
  type SettingsSection,
  type StartupEnvironmentApi,
  type StartupEnvironmentConfig,
  type StartupEnvironmentStatus,
  type TweakApi,
  type TweakFs,
  type TweakIpc,
  type TweakMcpApi,
  type TweakMcpCallResult,
  type TweakMcpRegistration,
  type TweakMcpServer,
  type TweakMcpTool,
  type TweakMcpToolContext,
  type TweakStorage,
} from "../src/index.ts";

test("accepts an explicit renderer manifest with Claude Sessions permission", () => {
  const result = validateTweakManifest({
    id: "com.claudeplusplus.probe",
    name: "Claude++ Probe",
    version: "0.2.0",
    githubRepo: "example/claudeplusplus-probe",
    scope: "renderer",
    main: "index.js",
    permissions: ["settings", "ipc", "claude-sessions"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("accepts complete Tweak metadata and permissions", () => {
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
        "claude-sessions",
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

test("exposes the focused Claude Sessions permission and rejects former private permissions", () => {
  assert.deepEqual(VALID_TWEAK_PERMISSIONS, [
    "ipc",
    "filesystem",
    "network",
    "settings",
    "claude-sessions",
    "startup-environment",
    "claude-code-settings",
    "mcp",
    "claude-session-title-write",
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

test("accepts Main runtime MCP and session title permissions", () => {
  const result = validateTweakManifest({
    id: "com.example.title",
    name: "Title",
    version: "0.1.0",
    githubRepo: "example/title",
    scope: "main",
    permissions: ["mcp", "claude-session-title-write"],
  });
  assert.equal(result.ok, true);
});

test("rejects Main-only MCP permissions on a Renderer Tweak", () => {
  for (const permission of ["mcp", "claude-session-title-write"] as const) {
    const result = validateTweakManifest({
      id: `com.example.${permission}`,
      name: permission,
      version: "0.1.0",
      githubRepo: "example/renderer",
      scope: "renderer",
      permissions: [permission],
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.path === "permissions[0]"), true);
  }
});

test("accepts a Main-capable startup environment declaration", () => {
  const result = validateTweakManifest({
    id: "com.example.startup-env",
    name: "Startup env",
    version: "0.1.0",
    githubRepo: "example/startup-env",
    scope: "both",
    permissions: ["startup-environment"],
    startupEnvironment: { keys: ["EXAMPLE_ONE", "EXAMPLE_TWO"] },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("requires startup environment permission and declaration together", () => {
  for (const manifest of [
    { permissions: ["startup-environment"] },
    { startupEnvironment: { keys: ["EXAMPLE_ONE"] } },
  ]) {
    const result = validateTweakManifest({
      id: "com.example.invalid-startup-env",
      name: "Invalid startup env",
      version: "0.1.0",
      githubRepo: "example/invalid-startup-env",
      scope: "both",
      ...manifest,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.path.startsWith("startupEnvironment")), true);
  }
});

test("rejects invalid, duplicate, empty, and Renderer-only startup environment declarations", () => {
  for (const manifest of [
    { startupEnvironment: { keys: ["BAD=KEY"] } },
    { startupEnvironment: { keys: ["DUP", "DUP"] } },
    { startupEnvironment: { keys: [] } },
    { scope: "renderer", startupEnvironment: { keys: ["EXAMPLE_ONE"] } },
  ]) {
    const result = validateTweakManifest({
      id: "com.example.invalid-startup-env",
      name: "Invalid startup env",
      version: "0.1.0",
      githubRepo: "example/invalid-startup-env",
      scope: "both",
      permissions: ["startup-environment"],
      ...manifest,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.path.startsWith("startupEnvironment")), true);
  }
});

test("accepts a Main-capable Claude Code settings declaration", () => {
  const result = validateTweakManifest({
    id: "com.example.code-settings",
    name: "Code settings",
    version: "0.1.0",
    githubRepo: "example/code-settings",
    scope: "both",
    permissions: ["claude-code-settings"],
    claudeCodeSettings: { paths: ["skillOverrides.claude-api"] },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("requires Claude Code settings permission and declaration together", () => {
  for (const manifest of [
    { permissions: ["claude-code-settings"] },
    { claudeCodeSettings: { paths: ["skillOverrides.claude-api"] } },
  ]) {
    const result = validateTweakManifest({
      id: "com.example.invalid-code-settings",
      name: "Invalid Code settings",
      version: "0.1.0",
      githubRepo: "example/invalid-code-settings",
      scope: "both",
      ...manifest,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.path.startsWith("claudeCodeSettings")), true);
  }
});

test("rejects unsafe, duplicate, overlapping, empty, and Renderer-only settings paths", () => {
  for (const declaration of [
    { paths: [] },
    { paths: ["skillOverrides..claude-api"] },
    { paths: ["skillOverrides.__proto__"] },
    { paths: ["skillOverrides.claude-api", "skillOverrides.claude-api"] },
    { paths: ["skillOverrides", "skillOverrides.claude-api"] },
    { paths: Array.from({ length: 65 }, (_, index) => `settings.path${index}`) },
    { paths: ["a".repeat(257)] },
    { paths: [123] },
  ]) {
    const result = validateTweakManifest({
      id: "com.example.invalid-code-settings",
      name: "Invalid Code settings",
      version: "0.1.0",
      githubRepo: "example/invalid-code-settings",
      scope: "both",
      permissions: ["claude-code-settings"],
      claudeCodeSettings: declaration,
    });

    assert.equal(result.ok, false, JSON.stringify(declaration));
    assert.equal(result.errors.some((issue) => issue.path.startsWith("claudeCodeSettings")), true);
  }

  const renderer = validateTweakManifest({
    id: "com.example.renderer-code-settings",
    name: "Renderer Code settings",
    version: "0.1.0",
    githubRepo: "example/renderer-code-settings",
    scope: "renderer",
    permissions: ["claude-code-settings"],
    claudeCodeSettings: { paths: ["skillOverrides.claude-api"] },
  });
  assert.equal(renderer.ok, false);
  assert.equal(renderer.errors.some((issue) => issue.path === "claudeCodeSettings"), true);
});

test("accepts Claude Code settings declarations at documented size boundaries", () => {
  for (const paths of [
    Array.from({ length: 64 }, (_, index) => `settings.path${index}`),
    ["a".repeat(256)],
  ]) {
    const result = validateTweakManifest({
      id: "com.example.boundary-code-settings",
      name: "Boundary Code settings",
      version: "0.1.0",
      githubRepo: "example/boundary-code-settings",
      scope: "main",
      permissions: ["claude-code-settings"],
      claudeCodeSettings: { paths },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  }
});

test("defineTweak preserves the lifecycle object", () => {
  const tweak = {
    start() {},
    stop() {},
  };

  assert.equal(defineTweak(tweak), tweak);
});

test("public API contracts support a permission-scoped Claude host adapter", async () => {
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
  const mcpContext: TweakMcpToolContext = { callerSessionId: "local_caller_session" };
  const mcpCallResult: TweakMcpCallResult = {
    content: [{ type: "text", text: "Renamed local_session to Renamed" }],
  };
  const mcpTool: TweakMcpTool = {
    name: "set_session_title",
    description: "Set a session title by explicit session ID.",
    inputSchema: {
      type: "object",
      required: ["session_id", "title"],
    },
    handler(input, context): TweakMcpCallResult {
      assert.deepEqual(input, { session_id: "local_session", title: "Renamed" });
      assert.equal(context, mcpContext);
      return mcpCallResult;
    },
  };
  const mcpServer: TweakMcpServer = {
    name: "claudepp_session_title",
    version: "0.1.0",
    tools: [mcpTool],
  };
  let mcpUnregistered = false;
  const mcpRegistration: TweakMcpRegistration = {
    async unregister(): Promise<void> {
      mcpUnregistered = true;
    },
  };
  const mcp: TweakMcpApi = {
    async registerServer(server): Promise<TweakMcpRegistration> {
      assert.equal(server, mcpServer);
      assert.equal(
        await server.tools[0]?.handler(
          { session_id: "local_session", title: "Renamed" },
          mcpContext,
        ),
        mcpCallResult,
      );
      return mcpRegistration;
    },
  };
  const claude: ClaudeApi = {
    sessions: {
      async resolveFile(sessionId, filePath): Promise<string | null> {
        assert.equal(sessionId, "local_session");
        assert.equal(filePath, "Assets/GameEntry.cs");
        return "D:\\workspace\\sgproj\\Assets\\GameEntry.cs";
      },
      async resolveReference(sessionId, entryId, label, occurrence, visibleCount): Promise<string | null> {
        assert.equal(sessionId, "local_session");
        assert.equal(entryId, "resp_file_link");
        assert.equal(label, "GameEntry.cs");
        assert.equal(occurrence, 0);
        assert.equal(visibleCount, 1);
        return "file:///D:/workspace/sgproj/Assets/GameEntry.cs#L12";
      },
      async getWorkspaceRoot(sessionId): Promise<string | null> {
        assert.equal(sessionId, "local_session");
        return "D:\\workspace\\sgproj";
      },
    },
  };
  const sessionTitleUpdate: ClaudeSessionTitleUpdate = {
    sessionId: "local_session",
    title: "Renamed",
  };
  const sessionTitles: ClaudeSessionTitlesApi = {
    async setTitle(sessionId, title, context): Promise<ClaudeSessionTitleUpdate> {
      assert.equal(sessionId, "local_session");
      assert.equal(title, "Renamed");
      assert.equal(context, mcpContext);
      return sessionTitleUpdate;
    },
  };
  const startupConfig: StartupEnvironmentConfig = {
    enabled: true,
    variables: { EXAMPLE_MAX: "272000" },
  };
  const startupStatus: StartupEnvironmentStatus = {
    saved: startupConfig,
    applied: null,
    restartRequired: true,
  };
  let relaunched = false;
  const startupEnvironment: StartupEnvironmentApi = {
    getStatus(): StartupEnvironmentStatus {
      return startupStatus;
    },
    save(config): StartupEnvironmentStatus {
      assert.equal(config, startupConfig);
      return startupStatus;
    },
    relaunch(): void {
      relaunched = true;
    },
  };
  const claudeCodeSettings: ClaudeCodeSettingsApi = {
    read(path) {
      assert.equal(path, "skillOverrides.claude-api");
      return { exists: false, revision: "missing:v1" };
    },
    write(path, value, expectedRevision) {
      assert.equal(path, "skillOverrides.claude-api");
      assert.equal(value, "off");
      assert.equal(expectedRevision, "missing:v1");
      return { exists: true, value, revision: "sha256:written" };
    },
    remove(path, expectedRevision) {
      assert.equal(path, "skillOverrides.claude-api");
      assert.equal(expectedRevision, "sha256:written");
      return { exists: false, revision: "sha256:removed" };
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
    claude,
  };
  const mainApi: TweakApi = {
    ...api,
    process: "main",
    claude: { sessionTitles },
    mcp,
    startupEnvironment,
    claudeCodeSettings,
  };

  storage.set("enabled", true);
  assert.equal(storage.get("enabled", false), true);
  assert.equal(api.settings?.register(section), handle);
  assert.equal(api.settings?.registerPage(page), handle);
  assert.equal(
    await api.claude?.sessions?.resolveFile("local_session", "Assets/GameEntry.cs"),
    "D:\\workspace\\sgproj\\Assets\\GameEntry.cs",
  );
  assert.equal(
    await api.claude?.sessions?.resolveReference("local_session", "resp_file_link", "GameEntry.cs", 0, 1),
    "file:///D:/workspace/sgproj/Assets/GameEntry.cs#L12",
  );
  assert.equal(
    await api.claude?.sessions?.getWorkspaceRoot("local_session"),
    "D:\\workspace\\sgproj",
  );
  assert.equal(mainApi.startupEnvironment?.getStatus(), startupStatus);
  assert.equal(mainApi.startupEnvironment?.save(startupConfig), startupStatus);
  mainApi.startupEnvironment?.relaunch();
  assert.equal(relaunched, true);
  const codeSettingsInitial = mainApi.claudeCodeSettings?.read("skillOverrides.claude-api");
  assert.deepEqual(codeSettingsInitial, { exists: false, revision: "missing:v1" });
  const codeSettingsWritten = mainApi.claudeCodeSettings?.write(
    "skillOverrides.claude-api",
    "off",
    codeSettingsInitial?.revision ?? "",
  );
  assert.equal(codeSettingsWritten?.value, "off");
  assert.equal(
    mainApi.claudeCodeSettings?.remove(
      "skillOverrides.claude-api",
      codeSettingsWritten?.revision ?? "",
    ).exists,
    false,
  );
  const registration = await mainApi.mcp?.registerServer(mcpServer);
  assert.equal(registration, mcpRegistration);
  await registration?.unregister();
  assert.equal(mcpUnregistered, true);
  assert.equal(
    await mainApi.claude?.sessionTitles?.setTitle("local_session", "Renamed", mcpContext),
    sessionTitleUpdate,
  );
});
