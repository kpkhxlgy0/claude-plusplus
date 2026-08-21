# Claude++ Tweak author workflow

Claude++ Tweaks are trusted local CommonJS modules loaded into Claude Desktop on Windows. Start with the scaffolded
four-file project, validate it with the public SDK rules, then use a contained development Junction for live work.

- [Getting started](./getting-started.md): create, validate, link, and choose a process scope.
- [Manifest reference](./manifest.md): every manifest field, permission, declaration, and Store metadata rule.
- [Runtime and lifecycle](./runtime-lifecycle.md): discovery, start/stop, hot reload, cleanup, Safe Mode, and locations.
- [SDK and API reference](./api-reference.md): the public Claude++ types and process-specific API leases.
- [TypeScript and bundling](./typescript-and-bundling.md): local SDK types and CommonJS esbuild targets.
- [Distribution and debugging](./distribution-debugging.md): release checks, reviewed Store commits, logs, and recovery.
- [Advanced Claude-specific capabilities](../tweak-authoring.md): startup environment, Claude Code settings,
  in-process MCP, and session titles.

The command-line workflow supports Windows development links only. It never executes Tweak source while creating,
validating, or linking a project.
