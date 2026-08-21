import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, win32 } from "node:path";
import type { TweakManifest } from "@claude-plusplus/sdk";
import type { DevTweakArguments } from "./tweak-arguments.js";
import {
  resolveClaudePlusPlusPaths,
  type ClaudePlusPlusPaths,
} from "./paths.js";
import {
  inspectTweakProject,
  requireValidInspection,
} from "./tweak-project.js";
import {
  consoleTweakCommandOutput,
  type TweakCommandOutput,
} from "./tweak-output.js";

export type DevTweakLinkStatus = "created" | "current" | "replaced";

export type DevTweakOptions = Partial<Omit<DevTweakArguments, "target">>;

export interface DevTweakResult {
  sourceDir: string;
  linkPath: string;
  markerPath: string;
  manifest: TweakManifest;
  linkStatus: DevTweakLinkStatus;
}

export interface PrepareDevTweakDependencies {
  paths: ClaudePlusPlusPaths;
  now(): number;
  output: TweakCommandOutput;
  platform(): NodeJS.Platform;
}

export function validateTweakLinkName(name: string): string {
  if (name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      "Tweak link name may contain only letters, numbers, dots, underscores, and dashes",
    );
  }
  return name;
}

export function assertWindowsTweakDevelopment(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    throw new Error("Tweak development links require Windows");
  }
}

export function ensureDevTweakLink(
  sourceDir: string,
  linkPath: string,
  paths: ClaudePlusPlusPaths,
  replace: boolean,
): DevTweakLinkStatus {
  assertImmediateTweakLink(linkPath, paths);
  const canonicalSource = realpathSync(sourceDir);
  if (!statSync(canonicalSource).isDirectory()) {
    throw new Error(`Tweak development source must be a directory: ${sourceDir}`);
  }

  const currentTarget = inspectExistingTweakLink(linkPath, paths);
  if (currentTarget === null) {
    createJunction(canonicalSource, linkPath, paths);
    return "created";
  }
  if (sameWindowsPath(currentTarget, canonicalSource)) return "current";
  if (!replace) {
    throw new Error(
      `tweak link already exists for ${basename(linkPath)}: ${currentTarget}\n` +
        "Pass --replace to point it at this source directory.",
    );
  }

  const recheckedTarget = inspectExistingTweakLink(linkPath, paths);
  if (recheckedTarget === null) {
    throw new Error(`Tweak link changed before replacement: ${linkPath}`);
  }
  if (sameWindowsPath(recheckedTarget, canonicalSource)) return "current";
  rmSync(linkPath, { recursive: true, force: true });
  createJunction(canonicalSource, linkPath, paths);
  return "replaced";
}

export function writeDevReloadMarker(
  paths: ClaudePlusPlusPaths,
  now: () => number = Date.now,
): string {
  mkdirSync(paths.tweaks, { recursive: true });
  const marker = join(paths.tweaks, ".claudepp-dev-reload");
  writeFileSync(marker, String(now()), "utf8");
  return marker;
}

export function prepareDevTweak(
  target = ".",
  options: DevTweakOptions = {},
  dependencies: Partial<PrepareDevTweakDependencies> = {},
): DevTweakResult {
  assertWindowsTweakDevelopment(
    (dependencies.platform ?? (() => process.platform))(),
  );

  const resolvedTarget = resolve(target);
  if (!statSync(resolvedTarget).isDirectory()) {
    throw new Error(`Tweak development source must be a directory: ${resolvedTarget}`);
  }

  const output = dependencies.output ?? consoleTweakCommandOutput;
  const inspection = inspectTweakProject(resolvedTarget);
  for (const issue of inspection.warnings) {
    output.warn(`warn ${issue.path}: ${issue.message}`);
  }
  const project = requireValidInspection(inspection);
  const paths = dependencies.paths ?? resolveClaudePlusPlusPaths();
  const linkName = validateTweakLinkName(options.name ?? project.manifest.id);
  const linkPath = join(paths.tweaks, linkName);
  const linkStatus = ensureDevTweakLink(
    project.sourceDir,
    linkPath,
    paths,
    options.replace === true,
  );
  const markerPath = writeDevReloadMarker(paths, dependencies.now ?? Date.now);

  output.log("✓ Claude++ dev link ready");
  output.log(`  Source: ${project.sourceDir}`);
  output.log(`  Linked: ${linkPath}`);
  output.log(`  Tweak:  ${project.manifest.id} (${project.manifest.scope ?? "both"})`);

  return {
    sourceDir: project.sourceDir,
    linkPath,
    markerPath,
    manifest: project.manifest,
    linkStatus,
  };
}

function assertImmediateTweakLink(
  linkPath: string,
  paths: ClaudePlusPlusPaths,
): void {
  const root = win32.resolve(paths.tweaks);
  const target = win32.resolve(linkPath);
  const child = win32.relative(root, target);
  if (
    !child ||
    child === "." ||
    /^\.\.([\\/]|$)/.test(child) ||
    win32.isAbsolute(child) ||
    child.includes("\\") ||
    child.includes("/")
  ) {
    throw new Error(`Tweak link must be an immediate child of ${paths.tweaks}`);
  }
}

function inspectExistingTweakLink(
  linkPath: string,
  paths: ClaudePlusPlusPaths,
): string | null {
  assertImmediateTweakLink(linkPath, paths);
  const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (linkStat === undefined) return null;
  if (!linkStat.isSymbolicLink()) {
    throw new Error(`target tweak path already exists and is not a symbolic link: ${linkPath}`);
  }
  if (!existsSync(linkPath)) {
    throw new Error(`Tweak link is broken and will not be replaced: ${linkPath}`);
  }

  let target: string;
  try {
    target = realpathSync(linkPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Tweak link target is malformed and will not be replaced: ${linkPath} (${detail})`);
  }
  if (!statSync(target).isDirectory()) {
    throw new Error(`Tweak link target is not a directory and will not be replaced: ${linkPath}`);
  }
  return target;
}

function createJunction(
  canonicalSource: string,
  linkPath: string,
  paths: ClaudePlusPlusPaths,
): void {
  assertImmediateTweakLink(linkPath, paths);
  mkdirSync(paths.tweaks, { recursive: true });
  symlinkSync(canonicalSource, linkPath, "junction");
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}
