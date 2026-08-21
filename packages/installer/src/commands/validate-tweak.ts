import {
  consoleTweakCommandOutput,
  type TweakCommandOutput,
} from "../tweak-output.js";
import {
  inspectTweakProject,
  requireValidInspection,
  type ValidTweakProject,
} from "../tweak-project.js";

export function validateTweak(
  target = ".",
  output: TweakCommandOutput = consoleTweakCommandOutput,
): ValidTweakProject {
  const inspection = inspectTweakProject(target);
  for (const issue of inspection.errors) {
    output.error(`error ${issue.path}: ${issue.message}`);
  }
  for (const issue of inspection.warnings) {
    output.warn(`warn ${issue.path}: ${issue.message}`);
  }
  if (inspection.errors.length > 0) {
    throw new Error(`tweak validation failed with ${inspection.errors.length} error(s)`);
  }
  const project = requireValidInspection(inspection);
  output.log(`valid ${project.manifest.id} (${project.entryPath})`);
  return project;
}
