import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
await rm(dist, { recursive: true, force: true });

const shared = {
  bundle: true,
  external: ["electron"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  target: "node22",
};

await build({
  ...shared,
  entryPoints: [resolve(packageRoot, "src", "main.ts")],
  outfile: resolve(dist, "main.js"),
});

await build({
  ...shared,
  entryPoints: [resolve(packageRoot, "src", "preload", "index.ts")],
  outfile: resolve(dist, "preload", "index.js"),
});
