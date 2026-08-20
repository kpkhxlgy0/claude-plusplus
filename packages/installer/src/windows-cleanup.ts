import { rm } from "node:fs/promises";
import {
  assertClaudePlusPlusStoreAppsPath,
  type ClaudePlusPlusPaths,
} from "./paths.js";

export interface WindowsCleanupFileSystem {
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const defaultFileSystem: WindowsCleanupFileSystem = { rm };

export async function cleanupWindowsManagedArtifacts(
  paths: ClaudePlusPlusPaths,
  fileSystem: WindowsCleanupFileSystem = defaultFileSystem,
): Promise<string[]> {
  assertClaudePlusPlusStoreAppsPath(paths);
  try {
    await fileSystem.rm(paths.storeApps, { recursive: true, force: true });
    return [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      `Could not remove Claude++ managed Store mirrors at ${paths.storeApps}. ` +
      `Close Claude++ and rerun uninstall. ${detail}`,
    ];
  }
}
