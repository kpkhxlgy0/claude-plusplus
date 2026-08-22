import type {
  SettingsHandle,
  SettingsPage,
  SettingsSection,
  TweakManifest,
} from "@claude-plusplus/sdk";
import {
  createClaudeSettingsShellAdapter,
  type SettingsShellAdapter,
  type SettingsShellEnvironment,
} from "./claude-settings-shell-adapter.js";
import {
  createLoadingSettingsProductServices,
  SettingsProductController,
  type ListedTweakView,
} from "../settings/product-controller.js";
import { renderTweaksPage } from "../settings/tweaks-page.js";
import { renderConfigPage } from "../settings/config-page.js";
import { renderStorePage } from "../settings/store-page.js";
import type { ClaudePlusPlusUpdateCheck } from "../config.js";

export type SettingsInjectorEnvironment = SettingsShellEnvironment;

let environment: SettingsInjectorEnvironment | null = null;
let adapter: SettingsShellAdapter | null = null;
let controller: SettingsProductController | null = null;
let settingsEnvironmentGeneration = 0;
let tweaksPath = "<user dir>/tweaks";
let managementInvoke: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => {
  throw new Error("Claude++ Settings management bridge is unavailable");
};

export function startSettingsInjector(
  nextEnvironment: SettingsInjectorEnvironment = {
    document,
    MutationObserver,
    ResizeObserver,
    getComputedStyle: (element) => getComputedStyle(element),
    getBoundingClientRect: (element) => element.getBoundingClientRect(),
    windowEvents: window,
  },
): void {
  if (environment?.document !== nextEnvironment.document) resetEnvironment();
  environment = nextEnvironment;
  if (!adapter) {
    const generation = settingsEnvironmentGeneration;
    const localAdapter = createClaudeSettingsShellAdapter(nextEnvironment);
    adapter = localAdapter;
    const services = createLoadingSettingsProductServices();
    let localController!: SettingsProductController;
    const isCurrent = (): boolean =>
      settingsEnvironmentGeneration === generation && controller === localController;
    const publishProductUpdate = (check: ClaudePlusPlusUpdateCheck | null): void => {
      if (isCurrent()) localController.setProductUpdateCheck(check);
    };
    localController = new SettingsProductController(localAdapter, {
      ...services,
      renderConfig: (context) => mountAsyncPage(renderConfigPage({
        root: context.root,
        invoke: managementInvokeTyped,
        publishProductUpdate,
      })),
      renderTweaks: (context) => renderTweaksPage({
        ...context,
        tweaksPath,
        invoke: <T = unknown>(channel: string, ...args: unknown[]) =>
          managementInvoke(channel, ...args) as Promise<T>,
        resolveIcon: resolveTweakIcon,
      }),
      renderStore: (context) => mountAsyncPage(renderStorePage({
        root: context.root,
        invoke: managementInvokeTyped,
        setStoreUpdateCount: context.setStoreUpdateCount,
        promptRepo: () => nextEnvironment.document.defaultView?.prompt(
          "GitHub repo (owner/repo or URL)",
        ) ?? null,
      })),
      openExternal: (url) => managementInvoke("claudepp:open-external", url),
    });
    controller = localController;
    let productCheckPendingForMount = false;
    const startProductCheck = (): void => {
      void managementInvokeTyped<ClaudePlusPlusUpdateCheck>(
        "claudepp:check-claudepp-update",
        false,
      )
        .then((check) => publishProductUpdate(check))
        .catch(() => publishProductUpdate(null));
    };
    localAdapter.setNavigationMountListener((visible) => {
      productCheckPendingForMount = !visible;
      if (visible) startProductCheck();
    });
    localController.start();
    localAdapter.setVisibilityListener((visible) => {
      if (!visible || !productCheckPendingForMount) return;
      productCheckPendingForMount = false;
      startProductCheck();
    });
  } else {
    controller!.start();
  }
}

export function registerSection(
  tweakId: string,
  section: SettingsSection,
): SettingsHandle {
  return requireController().registerSection(tweakId, section);
}

export function registerPage(
  tweakId: string,
  manifest: TweakManifest,
  page: SettingsPage,
): SettingsHandle {
  return requireController().registerPage(tweakId, manifest, page);
}

export function setListedTweaks(tweaks: ListedTweakView[]): void {
  requireController().setListedTweaks(tweaks);
}

export function setTweaksPath(path: string): void {
  tweaksPath = path;
}

export function setSettingsManagementBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): void {
  managementInvoke = invoke;
}

export function clearSettings(): void {
  controller?.clear();
}

export const clearSettingsPages = clearSettings;

function resetEnvironment(): void {
  settingsEnvironmentGeneration += 1;
  controller?.clear();
  adapter?.stop();
  controller = null;
  adapter = null;
  environment = null;
}

function requireController(): SettingsProductController {
  if (!controller) startSettingsInjector();
  return controller!;
}

async function resolveTweakIcon(tweak: ListedTweakView): Promise<string | null> {
  const iconUrl = tweak.manifest.iconUrl;
  if (!iconUrl) return null;
  if (/^(https?:|data:)/.test(iconUrl)) return iconUrl;
  const relative = iconUrl.startsWith("./") ? iconUrl.slice(2) : iconUrl;
  return await managementInvoke("claudepp:read-tweak-asset", tweak.dir, relative) as string;
}

function managementInvokeTyped<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return managementInvoke(channel, ...args) as Promise<T>;
}

function mountAsyncPage(result: Promise<() => void>): () => void {
  let disposed = false;
  let teardown: (() => void) | null = null;
  void result.then((nextTeardown) => {
    if (disposed) nextTeardown();
    else teardown = nextTeardown;
  });
  return () => {
    disposed = true;
    teardown?.();
    teardown = null;
  };
}
