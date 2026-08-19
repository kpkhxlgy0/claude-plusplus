import assert from "node:assert/strict";
import test from "node:test";
import type { TweakManifest, TweakMcpServer, TweakMcpTool } from "@claude-plusplus/sdk";
import { TweakMcpRegistry } from "../src/tweak-mcp-registry.ts";

test("registers one namespaced server and routes a tool call", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const registration = await lease.api.registerServer(server("claudepp_title", "v1"));

  assert.deepEqual(registry.snapshot().map((entry) => entry.name), ["claudepp_title"]);
  assert.deepEqual(
    await registry.invoke(
      "claudepp_title",
      "set",
      { title: "A" },
      { callerSessionId: "caller" },
    ),
    { content: [{ type: "text", text: "v1:A:caller" }] },
  );

  await registration.unregister();
  await assert.rejects(
    () => registry.invoke(
      "claudepp_title",
      "set",
      { title: "A" },
      { callerSessionId: "caller" },
    ),
    /not active/,
  );
});

test("rejects a server without the claudepp_ namespace", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => lease.api.registerServer(server("title", "v1")),
    /claudepp_/,
  );
});

test("rejects invalid characters in a namespaced server name", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => lease.api.registerServer(server("claudepp_Title", "v1")),
    /server name/i,
  );
});

test("rejects a server without tools", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => lease.api.registerServer({ name: "claudepp_title", tools: [] }),
    /at least one tool/i,
  );
});

test("rejects invalid tool names", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => lease.api.registerServer(server("claudepp_title", "v1", [tool("Set Title", "v1")])),
    /tool name/i,
  );
});

test("rejects duplicate tool names", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => lease.api.registerServer(server("claudepp_title", "v1", [
      tool("set", "v1"),
      tool("set", "v2"),
    ])),
    /duplicate tool name/i,
  );
});

test("rejects a non-object tool input schema", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const invalidTool = {
    ...tool("set", "v1"),
    inputSchema: [],
  } as unknown as TweakMcpTool;

  await assert.rejects(
    () => lease.api.registerServer(server("claudepp_title", "v1", [invalidTool])),
    /input schema/i,
  );
});

test("rejects an active server name owned by another Tweak", async () => {
  const registry = new TweakMcpRegistry();
  const first = registry.createApiLease(manifest("com.example.first"));
  const second = registry.createApiLease(manifest("com.example.second"));
  await first.api.registerServer(server("claudepp_title", "first"));

  await assert.rejects(
    () => second.api.registerServer(server("claudepp_title", "second")),
    /already active/,
  );
});

test("unregister is idempotent", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const registration = await lease.api.registerServer(server("claudepp_title", "v1"));
  let changes = 0;
  registry.subscribe(() => {
    changes += 1;
  });

  await registration.unregister();
  await registration.unregister();

  assert.equal(changes, 1);
  assert.deepEqual(registry.snapshot(), []);
});

test("disposing an API lease revokes all owned servers with one final change", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  await lease.api.registerServer(server("claudepp_title", "title"));
  await lease.api.registerServer(server("claudepp_archive", "archive"));
  const changes: Array<{ active: string[]; managedNames: readonly string[] }> = [];
  registry.subscribe((change) => {
    changes.push({
      active: change.snapshot.map((entry) => entry.name),
      managedNames: change.managedNames,
    });
  });

  await lease.dispose();
  await lease.dispose();

  assert.deepEqual(registry.snapshot(), []);
  assert.deepEqual(changes, [{
    active: [],
    managedNames: ["claudepp_archive", "claudepp_title"],
  }]);
  await assert.rejects(
    () => registry.invoke(
      "claudepp_title",
      "set",
      { title: "A" },
      { callerSessionId: "caller" },
    ),
    /not active/,
  );
});

test("retained lease methods reject after disposal", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const registerServer = lease.api.registerServer;
  const registration = await registerServer(server("claudepp_title", "v1"));
  const unregister = registration.unregister;

  await lease.dispose();

  await assert.rejects(
    () => registerServer(server("claudepp_archive", "v2")),
    /disposed/,
  );
  await assert.rejects(() => unregister(), /disposed/);
});

test("retained server objects cannot replace handlers without registration", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const retainedServer = server("claudepp_title", "registered");
  await lease.api.registerServer(retainedServer);
  retainedServer.tools[0].handler = () => ({
    content: [{ type: "text", text: "mutated" }],
  });

  assert.deepEqual(
    await registry.invoke(
      "claudepp_title",
      "set",
      { title: "A" },
      { callerSessionId: "caller" },
    ),
    { content: [{ type: "text", text: "registered:A:caller" }] },
  );
});

test("change notifications include the active snapshot and every managed name", async () => {
  const registry = new TweakMcpRegistry();
  const lease = registry.createApiLease(manifest("com.example.title"));
  const changes: Array<{ active: string[]; managedNames: readonly string[] }> = [];
  const unsubscribe = registry.subscribe((change) => {
    changes.push({
      active: change.snapshot.map((entry) => entry.name),
      managedNames: change.managedNames,
    });
  });
  const title = await lease.api.registerServer(server("claudepp_title", "title"));
  const archive = await lease.api.registerServer(server("claudepp_archive", "archive"));

  await title.unregister();
  unsubscribe();
  await archive.unregister();

  assert.deepEqual(changes, [
    {
      active: ["claudepp_title"],
      managedNames: ["claudepp_title"],
    },
    {
      active: ["claudepp_archive", "claudepp_title"],
      managedNames: ["claudepp_archive", "claudepp_title"],
    },
    {
      active: ["claudepp_archive"],
      managedNames: ["claudepp_archive", "claudepp_title"],
    },
  ]);
});

test("same-owner replacement swaps handlers for an identical canonical definition", async () => {
  const registry = new TweakMcpRegistry();
  const oldLease = registry.createApiLease(manifest("com.example.title"));
  const oldRegistration = await oldLease.api.registerServer(server(
    "claudepp_title",
    "old",
    [tool("set", "old", {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    })],
  ));
  const newLease = registry.createApiLease(manifest("com.example.title"));
  await newLease.api.registerServer(server(
    "claudepp_title",
    "new",
    [tool("set", "new", {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    })],
  ));

  assert.deepEqual(
    await registry.invoke(
      "claudepp_title",
      "set",
      { title: "A" },
      { callerSessionId: "caller" },
    ),
    { content: [{ type: "text", text: "new:A:caller" }] },
  );

  await oldRegistration.unregister();
  await oldLease.dispose();
  assert.deepEqual(
    await registry.invoke(
      "claudepp_title",
      "set",
      { title: "B" },
      { callerSessionId: "caller" },
    ),
    { content: [{ type: "text", text: "new:B:caller" }] },
  );
});

test("rejects same-name replacement whose schema differs", async () => {
  const registry = new TweakMcpRegistry();
  const first = registry.createApiLease(manifest("com.example.title"));
  await first.api.registerServer(server("claudepp_title", "old"));
  const replacement = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => replacement.api.registerServer(server("claudepp_title", "new", [
      tool("set", "new", {
        type: "object",
        properties: { value: { type: "number" } },
      }),
    ])),
    /structural definition/,
  );
});

test("rejects same-name replacement whose tool list differs", async () => {
  const registry = new TweakMcpRegistry();
  const first = registry.createApiLease(manifest("com.example.title"));
  await first.api.registerServer(server("claudepp_title", "old"));
  const replacement = registry.createApiLease(manifest("com.example.title"));

  await assert.rejects(
    () => replacement.api.registerServer(server("claudepp_title", "new", [
      tool("set", "new"),
      tool("get", "new"),
    ])),
    /structural definition/,
  );
});

test("rejects same-name replacement whose version differs", async () => {
  const registry = new TweakMcpRegistry();
  const first = registry.createApiLease(manifest("com.example.title"));
  await first.api.registerServer(server("claudepp_title", "old"));
  const replacement = registry.createApiLease(manifest("com.example.title"));
  const changed = server("claudepp_title", "new");
  changed.version = "2.0.0";

  await assert.rejects(
    () => replacement.api.registerServer(changed),
    /structural definition/,
  );
});

test("rejects same-name replacement whose tool description differs", async () => {
  const registry = new TweakMcpRegistry();
  const first = registry.createApiLease(manifest("com.example.title"));
  await first.api.registerServer(server("claudepp_title", "old"));
  const replacement = registry.createApiLease(manifest("com.example.title"));
  const changedTool = tool("set", "new");
  changedTool.description = "A changed description";

  await assert.rejects(
    () => replacement.api.registerServer(server("claudepp_title", "new", [changedTool])),
    /structural definition/,
  );
});

function manifest(id: string): TweakManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    githubRepo: "example/tweak",
    scope: "main",
    permissions: ["mcp"],
  };
}

function server(
  name: string,
  responseLabel: string,
  tools: readonly TweakMcpTool[] = [tool("set", responseLabel)],
): TweakMcpServer {
  return {
    name,
    version: "1.0.0",
    tools,
  };
}

function tool(
  name: string,
  responseLabel: string,
  inputSchema: Record<string, unknown> = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
): TweakMcpTool {
  return {
    name,
    description: "Set a title",
    inputSchema,
    handler(input, context) {
      return {
        content: [{
          type: "text",
          text: `${responseLabel}:${String(input.title)}:${context.callerSessionId}`,
        }],
      };
    },
  };
}
