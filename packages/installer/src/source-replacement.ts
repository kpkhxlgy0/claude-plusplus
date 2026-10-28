import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class UnsafeSourceReplacementError extends Error {}

/** Fail closed before replacing source or deleting its previous-version backup. */
export function assertSafeSourceReplacement(...targets: string[]): void {
  for (const target of targets) {
    rejectLinkedComponents(target);
    const absolute = canonicalPath(target);
    const home = canonicalPath(homedir());
    if (absolute === parse(absolute).root || relative(absolute, home) === "") {
      refuse(target, "filesystem or home root");
    }

    for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
      if (statIfPresent(ancestor)?.isDirectory() && hasGitEntry(ancestor)) refuse(target, "Git data");
      if (ancestor === dirname(ancestor)) break;
    }

    const existing = statIfPresent(absolute);
    if (!existing) continue;
    if (!existing.isDirectory()) refuse(target, "non-directory");
    const pending = [absolute];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.toLowerCase() === ".git") refuse(target, "Git data");
        // Recursive deletion removes links themselves; never inspect their targets.
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(directory, entry.name));
      }
    }
    if (readdirSync(absolute).length && !isSourceTree(absolute)) {
      refuse(target, "unrecognized source directory");
    }
  }
}

function refuse(target: string, reason: string): never {
  throw new UnsafeSourceReplacementError(
    `Refusing to replace ${reason}: ${target}. Update local checkouts with Git, then rerun their install.ps1.`,
  );
}

function hasGitEntry(directory: string): boolean {
  return readdirSync(directory).some(name => name.toLowerCase() === ".git");
}

function statIfPresent(target: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function rejectLinkedComponents(target: string): void {
  // Inspect the original spelling before resolve() erases a traversed link/.. pair.
  const raw = isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`;
  const root = parse(raw).root;
  const separator = process.platform === "win32" ? /[\\/]/ : /\//;
  let component = root;
  for (const part of raw.slice(root.length).split(separator)) {
    if (!part) continue;
    component += `${separator.test(component.slice(-1)) ? "" : sep}${part}`;
    if (statIfPresent(component)?.isSymbolicLink()) refuse(target, "symlink or junction path");
  }
}

function canonicalPath(target: string): string {
  let ancestor = resolve(target);
  const missing: string[] = [];
  while (!statIfPresent(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) refuse(target, "unavailable filesystem root");
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync.native(ancestor), ...missing);
}

function isSourceTree(directory: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown };
    if (pkg.name !== "claude-plusplus") return false;
    const source = [
      "install.ps1", "bin/claudeplusplus.js", "packages/installer/src/cli.ts",
      "packages/runtime/src/main.ts", "packages/loader/loader.cjs",
    ];
    const release = [
      "toolchain/node.exe", "packages/installer/dist/cli.js", "packages/runtime/dist/main.js",
      "packages/runtime/dist/preload/index.js", "packages/loader/loader.cjs",
      "bin/claudeplusplus.cmd", "store/index.json",
    ];
    return [source, release].some(files => files.every(file => statIfPresent(join(directory, file))?.isFile()));
  } catch {
    return false;
  }
}
