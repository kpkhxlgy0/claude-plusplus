import assert from "node:assert/strict";
import test from "node:test";
import type { TweakManifest, TweakMcpServer } from "@claude-plusplus/sdk";
import {
  ClaudeDesktopMcpService,
  type ClaudeDesktopMcpServiceLog,
} from "../src/claude-desktop-mcp-service.ts";
import type {
  ClaudeDesktopMcpBindings,
  ClaudeDesktopMcpCompatibility,
  InstallModuleObserverOptions,
  SdkMcpServer,
} from "../src/claude-desktop-mcp-compat.ts";

test("injects a converted always-loaded SDK server without changing Desktop entries", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const desktopServer = { type: "desktop" };
  const coordinator = new fixture.Coordinator("ccd", { desktop_server: desktopServer });

  const result = await coordinator.createAllServers("session-one", {});

  assert.equal(result.desktop_server, desktopServer);
  assert.equal(Object.hasOwn(coordinator.originalServers, "claudepp_session_title"), false);
  assert.equal(result.claudepp_session_title, fixture.createdServers[0]);
  assert.equal(fixture.convertedSchemas.length, 1);
  assert.equal(fixture.convertedSchemas[0].type, "object");
  assert.deepEqual(fixture.convertedSchemas[0].required, ["title"]);
  assert.equal(
    (fixture.convertedSchemas[0].properties as Record<string, { type: string }>).title.type,
    "string",
  );
  assert.deepEqual(fixture.createdOptions[0], {
    name: "claudepp_session_title",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [{
      name: "set_title",
      description: "Set a title",
      inputSchema: { title: "converted-title" },
      handler: fixture.createdOptions[0].tools[0].handler,
    }],
  });
});

test("injects only into CCD coordinators", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const coordinator = new fixture.Coordinator("other", { desktop_server: { type: "desktop" } });

  const result = await coordinator.createAllServers("session-one", {});

  assert.equal(result, coordinator.originalServers);
  assert.deepEqual(fixture.createdServers, []);
});

test("creates a distinct SDK server object for every caller session", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const first = new fixture.Coordinator("ccd", {});
  const second = new fixture.Coordinator("ccd", {});

  const firstResult = await first.createAllServers("session-one", {});
  const secondResult = await second.createAllServers("session-two", {});

  assert.notEqual(firstResult.claudepp_session_title, secondResult.claudepp_session_title);
  assert.equal(fixture.createdServers.length, 2);
});

test("routes an SDK handler through the registry with the literal caller session ID", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const coordinator = new fixture.Coordinator("ccd", {});
  await coordinator.createAllServers("literal-caller-session", {});

  const result = await fixture.createdOptions[0].tools[0].handler({ title: "New title" });

  assert.deepEqual(result, {
    content: [{ type: "text", text: "registered:New title:literal-caller-session" }],
  });
});

test("converts revoked and throwing Tweak handlers into MCP errors", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const registration = await fixture.registerServer(titleServer("registered"));
  const coordinator = new fixture.Coordinator("ccd", {});
  await coordinator.createAllServers("session-one", {});
  const handler = fixture.createdOptions[0].tools[0].handler;

  await registration.unregister();
  assert.deepEqual(await handler({ title: "New title" }), {
    content: [{
      type: "text",
      text: "MCP server \"claudepp_session_title\" is not active",
    }],
    isError: true,
  });

  const replacement = fixture.service.createMcpApiLease(manifest());
  await replacement.api.registerServer(titleServer("throw", true));
  assert.deepEqual(await handler({ title: "New title" }), {
    content: [{ type: "text", text: "Tweak handler failed" }],
    isError: true,
  });
});

test("keeps the original record and logs a server-name collision", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const existing = { type: "official" };
  const coordinator = new fixture.Coordinator("ccd", {
    claudepp_session_title: existing,
  });

  const result = await coordinator.createAllServers("session-one", {});

  assert.equal(result, coordinator.originalServers);
  assert.equal(result.claudepp_session_title, existing);
  assert.deepEqual(fixture.createdServers, []);
  assert.equal(fixture.logs.warn.length, 1);
  assert.match(String(fixture.logs.warn[0][0]), /collision/i);
});

test("keeps the original record when custom SDK server construction throws", async (t) => {
  const fixture = createFixture({ factoryError: new Error("factory failed") });
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const coordinator = new fixture.Coordinator("ccd", { desktop_server: { type: "desktop" } });

  const result = await coordinator.createAllServers("session-one", {});

  assert.equal(result, coordinator.originalServers);
  assert.deepEqual(Object.keys(result), ["desktop_server"]);
  assert.equal(fixture.logs.error.length, 1);
  assert.match(String(fixture.logs.error[0][0]), /session-one/);
});

test("does not reuse an earlier query's SDK object after reconstruction fails", async (t) => {
  const fixture = createFixture({ factoryErrorAfter: 1 });
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  await fixture.service.reconcileActiveSessions();
  const first = new fixture.Coordinator("ccd", {});
  await first.createAllServers("reused-session", {});
  const second = new fixture.Coordinator("ccd", {});

  const failedResult = await second.createAllServers("reused-session", {});
  const session = fixture.addSession("reused-session", {
    query: { type: "query" },
    isRunning: false,
    activeMcpServers: failedResult,
  });
  await fixture.service.reconcileActiveSessions();

  assert.equal(Object.hasOwn(failedResult, "claudepp_session_title"), false);
  assert.equal(Object.hasOwn(session.activeMcpServers, "claudepp_session_title"), false);
  assert.equal(fixture.createdServers.length, 1);
});

test("dispose restores only this service's coordinator wrapper", async () => {
  const owned = createFixture();
  const ownedWrapper = owned.Coordinator.prototype.createAllServers;
  assert.notEqual(ownedWrapper, owned.originalCreateAllServers);

  await owned.service.dispose();
  assert.equal(owned.Coordinator.prototype.createAllServers, owned.originalCreateAllServers);

  const displaced = createFixture();
  const foreignWrapper = async function () {
    return { foreign: true };
  };
  displaced.Coordinator.prototype.createAllServers = foreignWrapper;

  await displaced.service.dispose();
  assert.equal(displaced.Coordinator.prototype.createAllServers, foreignWrapper);
});

test("reconciles an idle live query through Desktop's apply method", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const desktopServer = { type: "desktop" };
  const session = fixture.addSession("idle-session", {
    query: { type: "query" },
    isRunning: false,
    activeMcpServers: { desktop_server: desktopServer },
  });

  await fixture.service.reconcileActiveSessions();

  assert.equal(session.activeMcpServers.desktop_server, desktopServer);
  assert.equal(session.activeMcpServers.claudepp_session_title, fixture.createdServers[0]);
  assert.ok(fixture.applyCalls.length >= 1);
  assert.equal(fixture.applyCalls.at(-1)?.[0], session);
  assert.equal(fixture.applyCalls.at(-1)?.[1], session.activeMcpServers);
  assert.equal(session.mcpServersDirty, false);
});

test("passes a running query's next map to Desktop for deferred application", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const session = fixture.addSession("running-session", {
    query: { type: "query" },
    isRunning: true,
    activeMcpServers: {},
  });

  await fixture.service.reconcileActiveSessions();

  assert.ok(fixture.applyCalls.length >= 1);
  assert.equal(fixture.applyCalls.at(-1)?.[0], session);
  assert.equal(fixture.applyCalls.at(-1)?.[1], session.activeMcpServers);
  assert.equal(session.deferredMcpServers, session.activeMcpServers);
  assert.equal(session.mcpServersDirty, true);
});

test("does not create an SDK instance for a cold session without a query", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  fixture.addSession("cold-session", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
  });

  await fixture.service.reconcileActiveSessions();
  assert.deepEqual(fixture.createdServers, []);
  assert.deepEqual(fixture.applyCalls, []);

  const coordinator = new fixture.Coordinator("ccd", {});
  const result = await coordinator.createAllServers("cold-session", {});
  assert.equal(result.claudepp_session_title, fixture.createdServers[0]);
  assert.equal(fixture.createdServers.length, 1);
});

test("removal deletes only the exact SDK object injected by Claude++", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const registration = await fixture.registerServer(titleServer("registered"));
  const desktopServer = { type: "desktop" };
  const session = fixture.addSession("idle-session", {
    query: { type: "query" },
    isRunning: false,
    activeMcpServers: { desktop_server: desktopServer },
  });
  await fixture.service.reconcileActiveSessions();
  const injected = session.activeMcpServers.claudepp_session_title;

  await registration.unregister();
  await fixture.service.reconcileActiveSessions();

  assert.notEqual(injected, undefined);
  assert.equal(Object.hasOwn(session.activeMcpServers, "claudepp_session_title"), false);
  assert.equal(session.activeMcpServers.desktop_server, desktopServer);
});

test("removal preserves a same-key object with a different identity", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const registration = await fixture.registerServer(titleServer("registered"));
  const session = fixture.addSession("idle-session", {
    query: { type: "query" },
    isRunning: false,
    activeMcpServers: {},
  });
  await fixture.service.reconcileActiveSessions();
  const foreignServer = { type: "foreign" };
  session.activeMcpServers = { claudepp_session_title: foreignServer };

  await registration.unregister();
  await fixture.service.reconcileActiveSessions();

  assert.equal(session.activeMcpServers.claudepp_session_title, foreignServer);
});

test("an already captured SDK handler resolves a same-structure replacement", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("old"));
  const coordinator = new fixture.Coordinator("ccd", {});
  await coordinator.createAllServers("hot-session", {});
  const capturedHandler = fixture.createdOptions[0].tools[0].handler;
  const replacement = fixture.service.createMcpApiLease(manifest());

  await replacement.api.registerServer(titleServer("new"));

  assert.deepEqual(await capturedHandler({ title: "New title" }), {
    content: [{ type: "text", text: "new:New title:hot-session" }],
  });
});

test("lease disposal revokes a captured handler before reconciliation", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  await fixture.registerServer(titleServer("registered"));
  const coordinator = new fixture.Coordinator("ccd", {});
  await coordinator.createAllServers("running-session", {});
  const capturedHandler = fixture.createdOptions[0].tools[0].handler;
  fixture.addSession("running-session", {
    query: { type: "query" },
    isRunning: true,
    activeMcpServers: {
      claudepp_session_title: fixture.createdServers[0],
    },
  });

  const disposal = fixture.mcpLease.dispose();
  const result = await capturedHandler({ title: "New title" });

  assert.deepEqual(result, {
    content: [{
      type: "text",
      text: "MCP server \"claudepp_session_title\" is not active",
    }],
    isError: true,
  });
  await disposal;
  await fixture.service.reconcileActiveSessions();
});

test("updates the current session title through the explicit-ID manager path", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  fixture.addSession("current-session-id", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  const result = await lease.api.setTitle(" current-session-id ", " New title ");

  assert.deepEqual(result, {
    sessionId: "current-session-id",
    title: "New title",
  });
  assert.deepEqual(fixture.updates, [[
    "current-session-id",
    { title: "New title", titleSource: "user" },
  ]]);
  assert.deepEqual(fixture.getSessionReads, ["current-session-id", "current-session-id"]);
});

test("resolves a Claude CLI session UUID to the Desktop session key before updating", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  fixture.addSession("local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", {
    cliSessionId: "11111111-2222-4333-8444-555555555555",
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  const result = await lease.api.setTitle(
    "11111111-2222-4333-8444-555555555555",
    "New title",
  );

  assert.deepEqual(result, {
    sessionId: "11111111-2222-4333-8444-555555555555",
    title: "New title",
  });
  assert.deepEqual(fixture.updates, [[
    "local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    { title: "New title", titleSource: "user" },
  ]]);
  assert.deepEqual(fixture.getSessionReads, [
    "11111111-2222-4333-8444-555555555555",
    "local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ]);
});

test("uses caller context when the private session record omits its CLI UUID", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const callerSessionId = "local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const callerCliSessionId = "11111111-2222-4333-8444-555555555555";
  fixture.addSession(callerSessionId, {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  fixture.setSessionSnapshot(callerSessionId, {
    sessionId: callerSessionId,
    cliSessionId: callerCliSessionId,
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  const result = await lease.api.setTitle(callerCliSessionId, "New title", {
    callerSessionId,
  });

  assert.deepEqual(result, { sessionId: callerCliSessionId, title: "New title" });
  assert.deepEqual(fixture.updates, [[
    callerSessionId,
    { title: "New title", titleSource: "user" },
  ]]);
});

test("uses the caller binding before scanning unrelated session snapshots", async (t) => {
  const fixture = createFixture({ getSessionErrorFor: "local_broken" });
  t.after(() => fixture.service.dispose());
  const callerSessionId = "local_caller";
  const callerCliSessionId = "11111111-2222-4333-8444-555555555555";
  fixture.addSession("local_broken", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Broken title",
  });
  fixture.addSession(callerSessionId, {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  fixture.setSessionSnapshot(callerSessionId, {
    sessionId: callerSessionId,
    cliSessionId: callerCliSessionId,
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  await lease.api.setTitle(callerCliSessionId, "New title", {
    callerSessionId,
  });

  assert.deepEqual(fixture.updates, [[
    callerSessionId,
    { title: "New title", titleSource: "user" },
  ]]);
});

test("resolves another session CLI UUID through public session snapshots", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const callerSessionId = "local_caller";
  const otherSessionId = "local_other";
  const callerCliSessionId = "11111111-2222-4333-8444-555555555555";
  const otherCliSessionId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  for (const sessionId of [callerSessionId, otherSessionId]) {
    fixture.addSession(sessionId, {
      query: null,
      isRunning: false,
      activeMcpServers: {},
      title: "Old title",
    });
  }
  fixture.setSessionSnapshot(callerSessionId, {
    sessionId: callerSessionId,
    cliSessionId: callerCliSessionId,
    title: "Old title",
  });
  fixture.setSessionSnapshot(otherSessionId, {
    sessionId: otherSessionId,
    cliSessionId: otherCliSessionId,
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  await lease.api.setTitle(otherCliSessionId, "Other new title", {
    callerSessionId,
  });

  assert.deepEqual(fixture.updates, [[
    otherSessionId,
    { title: "Other new title", titleSource: "user" },
  ]]);
});

test("rejects a CLI session UUID that maps to multiple Desktop sessions", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  for (const sessionId of ["local_first", "local_second"]) {
    fixture.addSession(sessionId, {
      cliSessionId: "11111111-2222-4333-8444-555555555555",
      query: null,
      isRunning: false,
      activeMcpServers: {},
      title: "Old title",
    });
  }
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(
    () => lease.api.setTitle("11111111-2222-4333-8444-555555555555", "New title"),
    /multiple Desktop sessions/i,
  );
  assert.deepEqual(fixture.updates, []);
});

test("prefers an exact Desktop session key over a conflicting CLI session alias", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  fixture.addSession("11111111-2222-4333-8444-555555555555", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Exact old title",
  });
  fixture.addSession("local_alias", {
    cliSessionId: "11111111-2222-4333-8444-555555555555",
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Alias old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  await lease.api.setTitle("11111111-2222-4333-8444-555555555555", "New title");

  assert.deepEqual(fixture.updates, [[
    "11111111-2222-4333-8444-555555555555",
    { title: "New title", titleSource: "user" },
  ]]);
});

test("updates another session through the same explicit-ID manager path", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  fixture.addSession("other-session-id", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Other old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  const result = await lease.api.setTitle("other-session-id", "Other new title");

  assert.deepEqual(result, {
    sessionId: "other-session-id",
    title: "Other new title",
  });
  assert.deepEqual(fixture.updates, [[
    "other-session-id",
    { title: "Other new title", titleSource: "user" },
  ]]);
});

test("rejects an empty explicit session ID", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("   ", "New title"), /session id/i);
  assert.deepEqual(fixture.getSessionReads, []);
  assert.deepEqual(fixture.updates, []);
});

test("rejects an empty trimmed title", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("session-id", "   "), /title/i);
  assert.deepEqual(fixture.getSessionReads, []);
  assert.deepEqual(fixture.updates, []);
});

test("rejects a title longer than 200 UTF-16 code units", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("session-id", "x".repeat(201)), /200/);
  assert.deepEqual(fixture.getSessionReads, []);
  assert.deepEqual(fixture.updates, []);
});

test("rejects an unknown explicit session ID without updating", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("unknown-session", "New title"), /not found/i);
  assert.deepEqual(fixture.getSessionReads, ["unknown-session"]);
  assert.deepEqual(fixture.updates, []);
});

test("propagates a Desktop title update failure without logging title text", async (t) => {
  const fixture = createFixture({ updateError: new Error("update failed") });
  t.after(() => fixture.service.dispose());
  fixture.addSession("session-id", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("session-id", "Secret new title"), /update failed/);
  assert.equal(JSON.stringify(fixture.logs).includes("Secret new title"), false);
});

test("rejects a session deleted after the title update", async (t) => {
  const fixture = createFixture({ deleteAfterUpdate: true });
  t.after(() => fixture.service.dispose());
  fixture.addSession("session-id", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("session-id", "New title"), /not found/i);
  assert.deepEqual(fixture.getSessionReads, ["session-id", "session-id"]);
});

test("rejects a title read-back mismatch", async (t) => {
  const fixture = createFixture({ readBackTitle: "Different title" });
  t.after(() => fixture.service.dispose());
  fixture.addSession("session-id", {
    query: null,
    isRunning: false,
    activeMcpServers: {},
    title: "Old title",
  });
  const lease = fixture.service.createSessionTitlesApiLease();

  await assert.rejects(() => lease.api.setTitle("session-id", "New title"), /did not match/i);
  assert.deepEqual(fixture.getSessionReads, ["session-id", "session-id"]);
});

test("a disposed title lease rejects before the first manager read", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.service.dispose());
  const lease = fixture.service.createSessionTitlesApiLease();
  const setTitle = lease.api.setTitle;

  await lease.dispose();

  await assert.rejects(() => setTitle("session-id", "New title"), /disposed/i);
  assert.deepEqual(fixture.getSessionReads, []);
  assert.deepEqual(fixture.updates, []);
});

interface CreatedToolOptions {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(input: Record<string, unknown>): Promise<unknown>;
}

interface CreatedServerOptions {
  name: string;
  version: string;
  alwaysLoad: boolean;
  tools: CreatedToolOptions[];
}

interface FakeSession {
  sessionId: string;
  cliSessionId?: string;
  query: unknown | null;
  isRunning: boolean;
  activeMcpServers: Record<string, unknown>;
  mcpServersDirty: boolean;
  deferredMcpServers?: Record<string, unknown>;
  title?: string;
}

function createFixture(options: {
  deleteAfterUpdate?: boolean;
  factoryError?: Error;
  factoryErrorAfter?: number;
  getSessionErrorFor?: string;
  readBackTitle?: string;
  updateError?: Error;
} = {}) {
  const createdOptions: CreatedServerOptions[] = [];
  const createdServers: SdkMcpServer[] = [];
  const convertedSchemas: Record<string, unknown>[] = [];
  const logs = {
    info: [] as unknown[][],
    warn: [] as unknown[][],
    error: [] as unknown[][],
  };
  const applyCalls: Array<[FakeSession, Record<string, unknown>]> = [];
  const getSessionReads: string[] = [];
  const updates: Array<[string, { title: string; titleSource: "user" }]> = [];
  let factoryAttempts = 0;
  const log: ClaudeDesktopMcpServiceLog = {
    info: (...args) => logs.info.push(args),
    warn: (...args) => logs.warn.push(args),
    error: (...args) => logs.error.push(args),
  };
  class Coordinator {
    public constructor(
      public readonly sessionType: string,
      public readonly originalServers: Record<string, unknown>,
    ) {}

    public async createAllServers(
      _sessionId: string,
      _options: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return this.originalServers;
    }
  }
  const originalCreateAllServers = Coordinator.prototype.createAllServers;
  const sessions = new Map<string, FakeSession>();
  const sessionSnapshots = new Map<string, unknown>();
  const bindings: ClaudeDesktopMcpBindings = {
    coordinatorConstructor: Coordinator,
    createSdkMcpServer(rawOptions) {
      const attempt = factoryAttempts;
      factoryAttempts += 1;
      if (
        options.factoryError
        || (options.factoryErrorAfter !== undefined && attempt >= options.factoryErrorAfter)
      ) {
        throw options.factoryError ?? new Error("factory failed");
      }
      const sdkOptions = rawOptions as unknown as CreatedServerOptions;
      const sdkServer: SdkMcpServer = {
        type: "sdk",
        name: sdkOptions.name,
        instance: { ordinal: createdServers.length + 1 },
      };
      createdOptions.push(sdkOptions);
      createdServers.push(sdkServer);
      return sdkServer;
    },
    jsonSchemaToZodShape(schema) {
      convertedSchemas.push(schema);
      return { title: "converted-title" };
    },
    sessionManager: {
      sessions: sessions as Map<string, unknown>,
      getSession: async (rawSessionId) => {
        const sessionId = String(rawSessionId);
        getSessionReads.push(sessionId);
        if (sessionId === options.getSessionErrorFor) throw new Error("session read failed");
        return sessionSnapshots.get(sessionId) ?? sessions.get(sessionId) ?? null;
      },
      updateSession: async (rawSessionId, rawUpdate) => {
        const sessionId = String(rawSessionId);
        const update = rawUpdate as { title: string; titleSource: "user" };
        updates.push([sessionId, update]);
        if (options.updateError) throw options.updateError;
        const session = sessions.get(sessionId);
        if (!session) return;
        if (options.deleteAfterUpdate) {
          sessions.delete(sessionId);
          sessionSnapshots.delete(sessionId);
          return;
        }
        session.title = options.readBackTitle ?? update.title;
        const snapshot = sessionSnapshots.get(sessionId);
        if (snapshot && typeof snapshot === "object") {
          (snapshot as { title?: string }).title = options.readBackTitle ?? update.title;
        }
      },
      applyMcpServersIfIdle: async (rawSession, rawServers) => {
        const session = rawSession as FakeSession;
        const servers = rawServers as Record<string, unknown>;
        applyCalls.push([session, servers]);
        if (session.isRunning) {
          session.mcpServersDirty = true;
          session.deferredMcpServers = servers;
        } else {
          session.mcpServersDirty = false;
        }
      },
    },
  };
  const service = new ClaudeDesktopMcpService({
    desktopVersion: "1.26832.0",
    installModuleObserver(observerOptions: InstallModuleObserverOptions): ClaudeDesktopMcpCompatibility {
      observerOptions.onBindings(bindings);
      return {
        status: "supported",
        bindings,
        dispose() {},
      };
    },
    log,
  });
  service.installEarly();
  const lease = service.createMcpApiLease(manifest());

  return {
    Coordinator,
    originalCreateAllServers,
    service,
    createdOptions,
    createdServers,
    convertedSchemas,
    logs,
    applyCalls,
    getSessionReads,
    updates,
    mcpLease: lease,
    addSession(
      sessionId: string,
      session: Omit<FakeSession, "sessionId" | "mcpServersDirty">,
    ): FakeSession {
      const complete: FakeSession = {
        sessionId,
        mcpServersDirty: false,
        ...session,
      };
      sessions.set(sessionId, complete);
      return complete;
    },
    setSessionSnapshot(sessionId: string, snapshot: unknown): void {
      sessionSnapshots.set(sessionId, snapshot);
    },
    registerServer: (server: TweakMcpServer) => lease.api.registerServer(server),
  };
}

function manifest(): TweakManifest {
  return {
    id: "com.example.session-title",
    name: "Session Title",
    version: "1.0.0",
    githubRepo: "example/session-title",
    scope: "main",
    permissions: ["mcp", "claude-session-title-write"],
  };
}

function titleServer(label: string, throws = false): TweakMcpServer {
  return {
    name: "claudepp_session_title",
    version: "1.0.0",
    tools: [{
      name: "set_title",
      description: "Set a title",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      handler(input, context) {
        if (throws) throw new Error("Tweak handler failed");
        return {
          content: [{
            type: "text",
            text: `${label}:${String(input.title)}:${context.callerSessionId}`,
          }],
        };
      },
    }],
  };
}
