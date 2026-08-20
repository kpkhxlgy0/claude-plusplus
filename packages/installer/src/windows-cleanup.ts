import { rm } from "node:fs/promises";
import {
  assertClaudePlusPlusStoreAppsPath,
  type ClaudePlusPlusPaths,
} from "./paths.js";

export async function cleanupWindowsManagedArtifacts(
  paths: ClaudePlusPlusPaths,
): Promise<string[]> {
  assertClaudePlusPlusStoreAppsPath(paths);
  try {
    await rm(paths.storeApps, { recursive: true, force: true });
    return [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      `Could not remove Claude++ managed Store mirrors at ${paths.storeApps}. ` +
      `Close Claude++ and rerun uninstall. ${detail}`,
    ];
  }
}
