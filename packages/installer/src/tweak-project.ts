import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const entry = resolveTweakEntry(sourceDir, manifest);
  const entryPath = entry.status === "valid" ? entry.path : null;
  if (entry.status !== "valid") {
    errors.push({
      path: "main",
      message: manifest.main && entry.status === "invalid"
        ? `entry file must resolve to a regular file inside the Tweak source project: ${manifest.main}`
        : manifest.main
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
  if (inspection.manifest === null || inspection.entryPath === null) {
    throw new Error("invalid Tweak project inspection: manifest and entryPath are required");
  }
  return {
    ...inspection,
    manifest: inspection.manifest,
    entryPath: inspection.entryPath,
    errors: [],
  };
}

export function requireValidTweakProject(target = "."): ValidTweakProject {
  return requireValidInspection(inspectTweakProject(target));
}

type TweakEntryResolution =
  | { status: "valid"; path: string }
  | { status: "missing" | "invalid" };

function resolveTweakEntry(
  sourceDir: string,
  manifest: TweakManifest,
): TweakEntryResolution {
  let canonicalSourceDir: string;
  try {
    canonicalSourceDir = realpathSync(sourceDir);
  } catch (error) {
    if (isMissingPathError(error)) return { status: "missing" };
    throw error;
  }
  if (manifest.main) {
    if (
      isAbsolute(manifest.main) ||
      /^[A-Za-z]:/.test(manifest.main) ||
      manifest.main.split(/[\\/]+/).includes("..")
    ) {
      return { status: "invalid" };
    }
    const explicit = resolve(sourceDir, manifest.main);
    return resolveEntryCandidate(canonicalSourceDir, explicit);
  }

  for (const candidate of TWEAK_ENTRY_CANDIDATES) {
    const entry = join(sourceDir, candidate);
    const resolved = resolveEntryCandidate(canonicalSourceDir, entry);
    if (resolved.status === "valid") return resolved;
  }
  return { status: "missing" };
}

function resolveEntryCandidate(
  canonicalSourceDir: string,
  candidate: string,
): TweakEntryResolution {
  try {
    const canonicalEntry = realpathSync(candidate);
    if (!isPathInside(canonicalSourceDir, canonicalEntry) || !statSync(canonicalEntry).isFile()) {
      return { status: "invalid" };
    }
    return { status: "valid", path: candidate };
  } catch (error) {
    return isMissingPathError(error) ? { status: "missing" } : { status: "invalid" };
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}
