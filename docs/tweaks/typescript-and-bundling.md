# TypeScript and bundling

Claude++ loads JavaScript entry files. It does not transpile TypeScript, JSX, raw ESM syntax, or dependencies at Tweak
load time. Bundle to CommonJS and keep the output inside the Tweak project before validation.

## Install local SDK types

Install `@claude-plusplus/sdk` from the locally installed Claude++ source checkout, together with your chosen
compiler/bundler:

```powershell
npm install --save-dev "$env:USERPROFILE\.claude-plusplus\source\packages\sdk"
npm install --save-dev typescript esbuild
```

The SDK source path is `%USERPROFILE%\.claude-plusplus\source\packages\sdk`. Plain JavaScript Tweaks need no SDK
dependency. Reinstall the local type package after a Claude++ update when you need newly added public interfaces.

## Type-only source

Keep SDK imports type-only so the Tweak has no Runtime module-resolution dependency:

```ts
import type { Tweak, TweakApi } from "@claude-plusplus/sdk";

function reportStart(api: TweakApi): void {
  api.log.info("started", api.manifest.id, api.process);
}

const tweak: Tweak = {
  start(api) {
    reportStart(api);
  },
  stop() {},
};

export default tweak;
```

Claude++ accepts CommonJS `module.exports`, `exports`, and bundled default-export wrappers. The output itself must be
runtime-loadable CommonJS.

## Renderer bundle

Use a browser target so Node built-ins do not leak into the Renderer bundle:

```powershell
npx esbuild .\src\index.ts `
  --bundle `
  --platform=browser `
  --format=cjs `
  --outfile=index.js
claudeplusplus validate-tweak .
```

Renderer source may use DOM APIs inside `start()`/render callbacks. It cannot use Node `require`, including to load a
sibling bundle at runtime.

## Main bundle

Main runs as trusted local Node.js code, so use the Node target:

```powershell
npx esbuild .\src\index.ts `
  --bundle `
  --platform=node `
  --format=cjs `
  --outfile=index.js
claudeplusplus validate-tweak .
```

Declare every Claude++ permission the Main implementation uses. Node access itself is not sandboxed by those
permissions.

## Both-process bundle

`scope: "both"` points Main and Renderer at the same manifest entry. Keep top-level code neutral: do not touch DOM
globals or import Node-only modules until after a process branch. For a dependency-light shared entry, build a neutral
CommonJS bundle:

```powershell
npx esbuild .\src\index.ts `
  --bundle `
  --platform=neutral `
  --format=cjs `
  --outfile=index.js
```

```ts
import type { Tweak } from "@claude-plusplus/sdk";

let settingsHandle: { unregister(): void } | undefined;

const tweak: Tweak = {
  start(api) {
    if (api.process === "main") {
      api.ipc.handle?.("ping", () => "pong");
      return;
    }

    settingsHandle = api.settings?.registerPage({
      id: "main",
      title: "Ping",
      render(root) {
        const button = document.createElement("button");
        button.textContent = "Ping Main";
        button.onclick = async () => {
          button.textContent = String(await api.ipc.invoke("ping"));
        };
        root.append(button);
      },
    });
  },
  stop() {
    settingsHandle?.unregister();
    settingsHandle = undefined;
  },
};

export default tweak;
```

Each process evaluates this module independently, so the Renderer handle above is local to its Renderer instance.

If dependencies cannot produce one neutral, Renderer-safe output, prefer separate Tweak projects/scopes or redesign
the shared entry. A Renderer branch cannot lazily `require()` a Main-only sibling. The default workflow promises no
JSX, React, or host-private component API; build UI with the public Settings/DOM surface.

## Package scripts

Choose the target that matches the manifest scope:

```json
{
  "private": true,
  "type": "commonjs",
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=browser --format=cjs --outfile=index.js",
    "validate": "claudeplusplus validate-tweak .",
    "dev": "claudeplusplus dev ."
  }
}
```

Run build before validation. The entry validator rejects canonical targets outside the project, so copy/bundle all
release output beneath the Tweak root.
