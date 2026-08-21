import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
  validateTweakManifest,
  type TweakManifest,
  type TweakScope,
} from "@claude-plusplus/sdk";
import type { CreateTweakArguments } from "../tweak-arguments.js";
import {
  consoleTweakCommandOutput,
  type TweakCommandOutput,
} from "../tweak-output.js";

export interface CreateTweakOptions
  extends Partial<Omit<CreateTweakArguments, "target">> {
  id?: string;
  name?: string;
  repo?: string;
  scope?: TweakScope;
  force?: boolean;
}

export interface CreatedTweakProject {
  directory: string;
  manifest: TweakManifest;
}

export function createTweak(
  target: string,
  options: CreateTweakOptions = {},
  output: TweakCommandOutput = consoleTweakCommandOutput,
): CreatedTweakProject {
  if (!target) throw new Error("target directory is required");

  const directory = resolve(target);
  const slug = slugify(basename(directory));
  const scope = options.scope ?? "both";

  if (existsSync(directory)) {
    if (!statSync(directory).isDirectory()) {
      throw new Error(`target already exists and is not a directory: ${directory}`);
    }
    if (readdirSync(directory).length > 0) {
      throw new Error(`target already exists and is not empty: ${directory}`);
    }
    if (options.force !== true) {
      throw new Error(`target already exists; use --force for an empty directory: ${directory}`);
    }
  }

  const manifest: TweakManifest = {
    id: options.id ?? `com.example.${slug}`,
    name: options.name ?? titleize(slug),
    version: "0.1.0",
    githubRepo: options.repo ?? `example/${slug}`,
    description: "A Claude++ Tweak.",
    scope,
    main: "index.js",
    permissions: permissionsForScope(scope),
  };
  const validation = validateTweakManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  }

  const entrySource = templateForScope(scope);
  const packageJson = {
    name: slug,
    version: manifest.version,
    private: true,
    type: "commonjs",
    scripts: {
      validate: "claudeplusplus validate-tweak .",
      dev: "claudeplusplus dev .",
    },
  };
  const readmeSource = readme(manifest);

  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeJson(directory, "manifest.json", manifest);
  writeFileSync(resolve(directory, "index.js"), entrySource, "utf8");
  writeJson(directory, "package.json", packageJson);
  writeFileSync(resolve(directory, "README.md"), readmeSource, "utf8");

  output.log("✓ Created Claude++ Tweak");
  output.log(`  Directory: ${directory}`);
  output.log(`  Manifest:  ${resolve(directory, "manifest.json")}`);
  output.log("");
  output.log("Next:");
  output.log(`  1. Edit ${resolve(directory, "manifest.json")}`);
  output.log(`  2. Run claudeplusplus validate-tweak ${directory}`);
  output.log(`  3. Run claudeplusplus dev ${directory}`);

  return { directory, manifest };
}

function permissionsForScope(scope: TweakScope): NonNullable<TweakManifest["permissions"]> {
  if (scope === "renderer") return ["settings"];
  if (scope === "main") return ["ipc"];
  return ["settings", "ipc"];
}

function templateForScope(scope: TweakScope): string {
  if (scope === "renderer") return rendererTemplate();
  if (scope === "main") return mainTemplate();
  return bothTemplate();
}

function rendererTemplate(): string {
  return `let settingsHandle;

function start(api) {
  if (!api.settings || typeof api.settings.registerPage !== "function") {
    throw new Error("Renderer Settings API is unavailable.");
  }
  settingsHandle = api.settings.registerPage({
    id: "main",
    title: api.manifest.name,
    render(root) {
      root.textContent = "Renderer Tweak loaded.";
    },
  });
}

function stop() {
  settingsHandle?.unregister();
  settingsHandle = undefined;
}

module.exports = { start, stop };
`;
}

function mainTemplate(): string {
  return `function start(api) {
  if (!api.ipc || typeof api.ipc.handle !== "function") {
    throw new Error("Main IPC API is unavailable.");
  }
  api.log.info("Main Tweak started.");
  api.ipc.handle("ping", () => "pong from main");
}

function stop() {
  // Release listeners, timers, and other resources here.
}

module.exports = { start, stop };
`;
}

function bothTemplate(): string {
  return `let settingsHandle;

function start(api) {
  if (api.process === "main") {
    if (!api.ipc || typeof api.ipc.handle !== "function") {
      throw new Error("Main IPC API is unavailable.");
    }
    api.log.info("Main half started.");
    api.ipc.handle("ping", () => "pong from main");
    return;
  }

  if (api.process === "renderer") {
    if (!api.settings || typeof api.settings.registerPage !== "function") {
      throw new Error("Renderer Settings API is unavailable.");
    }
    settingsHandle = api.settings.registerPage({
      id: "main",
      title: api.manifest.name,
      render(root) {
        root.textContent = "";
        const button = root.ownerDocument.createElement("button");
        const output = root.ownerDocument.createElement("p");
        button.textContent = "Ping main";
        output.textContent = "Click the button to test Renderer-to-Main IPC.";
        button.onclick = async () => {
          output.textContent = String(await api.ipc.invoke("ping"));
        };
        root.append(button, output);
      },
    });
    return;
  }

  throw new Error("Unknown Tweak process.");
}

function stop() {
  settingsHandle?.unregister();
  settingsHandle = undefined;
}

module.exports = { start, stop };
`;
}

function readme(manifest: TweakManifest): string {
  return `# ${manifest.name}

${manifest.description}

## Project files

- \`manifest.json\` declares the Tweak metadata, process scope, and permissions.
- \`index.js\` exports the runnable CommonJS \`start(api)\` and \`stop()\` lifecycle.
- \`package.json\` provides the validation and development commands.
- \`README.md\` is this guide.

## Validate

\`\`\`sh
npm run validate
\`\`\`

## Develop

\`\`\`sh
npm run dev
npm run dev -- --no-watch
\`\`\`

Development links this project into \`%APPDATA%\\claude-plusplus\\tweaks\`, the live Tweak destination.

Release listeners, timers, Settings handles, and other resources in \`stop()\`. If Renderer changes do not apply to an existing Claude Session, restart Claude.
`;
}

function writeJson(directory: string, name: string, value: unknown): void {
  writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "my-tweak";
}

function titleize(input: string): string {
  return input
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
