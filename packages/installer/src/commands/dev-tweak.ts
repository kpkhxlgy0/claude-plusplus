import {
  resolveClaudePlusPlusPaths,
  type ClaudePlusPlusPaths,
} from "../paths.js";
import {
  prepareDevTweak,
  type DevTweakOptions,
  type DevTweakResult,
  type PrepareDevTweakDependencies,
} from "../tweak-dev-link.js";
import { watchTweakProject } from "../tweak-dev-watch.js";
import {
  consoleTweakCommandOutput,
  type TweakCommandOutput,
} from "../tweak-output.js";

export interface DevTweakDependencies {
  paths: ClaudePlusPlusPaths;
  now(): number;
  platform(): NodeJS.Platform;
  output: TweakCommandOutput;
  prepare(
    target: string,
    options: DevTweakOptions,
    dependencies: Partial<PrepareDevTweakDependencies>,
  ): DevTweakResult;
  watchForChanges(sourceDir: string, paths: ClaudePlusPlusPaths): Promise<void>;
}

export async function devTweak(
  target = ".",
  options: DevTweakOptions = {},
  dependencies: Partial<DevTweakDependencies> = {},
): Promise<DevTweakResult> {
  const output = dependencies.output ?? consoleTweakCommandOutput;
  const paths = dependencies.paths ?? resolveClaudePlusPlusPaths();
  const prepare = dependencies.prepare ?? prepareDevTweak;
  const result = prepare(target, options, {
    paths,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    output,
  });
  if (options.watch === false) return result;

  output.log("watching for changes; press Ctrl+C to stop");
  const watchForChanges = dependencies.watchForChanges ??
    ((source: string, watchPaths: ClaudePlusPlusPaths) => watchTweakProject(
      source,
      watchPaths,
      {
        ...(dependencies.platform ? { platform: dependencies.platform } : {}),
        output,
      },
    ));
  await watchForChanges(result.sourceDir, paths);
  return result;
}
