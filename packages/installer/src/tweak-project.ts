import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  validateTweakManifest,
  type TweakManifest,
  type TweakManifestIssue,
} from "@claude-plusplus/sdk";

export const TWEAK_ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"] as const;

export interface TweakProjectInspection {
  sourceDir: string;
  manifestPath: string;
  manifest: TweakManifest | null;
  entryPath: string | null;
  errors: TweakManifestIssue[];
  warnings: TweakManifestIssue[];
}

export interface ValidTweakProject extends TweakProjectInspection {
  manifest: TweakManifest;
  entryPath: string;
  errors: [];
}

export function inspectTweakProject(target = "."): TweakProjectInspection {
  const resolvedTarget = resolve(target);
  if (!existsSync(resolvedTarget)) {
    throw new Error(`target does not exist: ${resolvedTarget}`);
  }

  const manifestPath = statSync(resolvedTarget).isDirectory()
    ? join(resolvedTarget, "manifest.json")
    : resolvedTarget;
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`manifest is not valid JSON: ${message}`);
  }

  const sourceDir = dirname(manifestPath);
  const validation = validateTweakManifest(rawManifest);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];
  if (!validation.ok) {
    return {
      sourceDir,
      manifestPath,
      manifest: null,
      entryPath: null,
      errors,
      warnings,
    };
  }

  const manifest = rawManifest as TweakManifest;
  const entryPath = resolveTweakEntry(sourceDir, manifest);
  if (entryPath === null) {
    errors.push({
      path: "main",
      message: manifest.main
        ? `entry file does not exist: ${manifest.main}`
        : `no entry file found; expected one of ${TWEAK_ENTRY_CANDIDATES.join(", ")}`,
    });
  }

  return {
    sourceDir,
    manifestPath,
    manifest,
    entryPath,
    errors,
    warnings,
  };
}

export function requireValidInspection(
  inspection: TweakProjectInspection,
): ValidTweakProject {
  if (inspection.errors.length > 0) {
    throw new Error(
      inspection.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  }
  return inspection as ValidTweakProject;
}

export function requireValidTweakProject(target = "."): ValidTweakProject {
  return requireValidInspection(inspectTweakProject(target));
}

function resolveTweakEntry(sourceDir: string, manifest: TweakManifest): string | null {
  if (manifest.main) {
    const explicit = resolve(sourceDir, manifest.main);
    return existsSync(explicit) ? explicit : null;
  }

  for (const candidate of TWEAK_ENTRY_CANDIDATES) {
    const entry = join(sourceDir, candidate);
    if (existsSync(entry)) return entry;
  }
  return null;
}
