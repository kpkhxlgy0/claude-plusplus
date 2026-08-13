import { ipcRenderer } from "electron";
import type { TweakLogger } from "@claude-plusplus/sdk";
import { createRendererLogger } from "./renderer-logger.js";
import {
  clearSettings,
  registerPage,
  registerSection,
  setSettingsManagementBridge,
  setListedTweaks,
  setTweaksPath,
  startSettingsInjector,
} from "./settings-injector.js";
import {
  createRendererTweakRuntime,
  type RendererTweakCatalog,
} from "./tweak-host.js";
import type { ListedTweakView } from "../settings/types.js";

export async function bootstrapRendererRuntime(
  log: TweakLogger = createRendererLogger(ipcRenderer),
): Promise<void> {
  log.info("Renderer Tweak discovery started");
  setSettingsManagementBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args));
  startSettingsInjector();
  const runtime = createRendererTweakRuntime({
    loadCatalog: async (): Promise<RendererTweakCatalog> => {
      const [tweaks, paths] = await Promise.all([
        ipcRenderer.invoke("claudepp:list-tweaks") as Promise<ListedTweakView[]>,
        ipcRenderer.invoke("claudepp:user-paths") as Promise<{ tweaksDir: string }>,
      ]);
      return { tweaks, tweaksPath: paths.tweaksDir };
    },
    readTweakSource: (entry) => ipcRenderer.invoke("claudepp:read-tweak-source", entry) as Promise<string>,
    publishCatalog: (tweaks, path) => {
      setTweaksPath(path);
      setListedTweaks(tweaks);
    },
    subscribeReload: (listener) => {
      const handler = (): void => listener();
      ipcRenderer.on("claudepp:tweaks-changed", handler);
      return () => ipcRenderer.removeListener("claudepp:tweaks-changed", handler);
    },
    clearSettings,
    log,
    storage: window.localStorage,
    ipc: ipcRenderer,
    settings: { registerSection, registerPage },
  });
  await runtime.start();
  window.addEventListener("beforeunload", () => {
    void runtime.dispose();
  }, { once: true });
  log.info("Renderer Tweaks started");
}

const log = createRendererLogger(ipcRenderer);
log.info(`Renderer preload evaluated; document.readyState=${document.readyState}`);
const start = () => {
  log.info("Renderer DOM is ready");
  void bootstrapRendererRuntime(log).catch((error) => {
    log.error(`Renderer Runtime failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
};
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
