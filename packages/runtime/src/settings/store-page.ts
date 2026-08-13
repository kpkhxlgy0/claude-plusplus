import type {
  TweakStoreEntryView,
  TweakStoreRegistryView,
} from "../tweak-store.js";
import {
  settingsButton,
  settingsCard,
  settingsMessageRow,
  settingsSection,
} from "./components.js";

export interface StorePageContext {
  root: HTMLElement;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  setStoreUpdateCount(count: number): void;
  promptRepo(): string | null;
}

let cachedStore: TweakStoreRegistryView | null = null;
let storePromise: Promise<TweakStoreRegistryView> | null = null;
let currentStoreUpdateCount = 0;

export async function renderStorePage(
  context: StorePageContext,
  provided?: TweakStoreRegistryView,
  force = false,
): Promise<() => void> {
  let disposed = false;
  renderStoreLoading(context);
  try {
    const store = provided ?? await getStore(context, force);
    if (!disposed) renderStore(context, store);
  } catch (error) {
    if (!disposed) renderStoreError(context, error);
  }
  return () => { disposed = true; };
}

export function clearStoreCache(): void {
  cachedStore = null;
  storePromise = null;
}

function getStore(context: StorePageContext, force: boolean): Promise<TweakStoreRegistryView> {
  if (!force && cachedStore) return Promise.resolve(cachedStore);
  if (!force && storePromise) return storePromise;
  const pending = context.invoke<TweakStoreRegistryView>("claudepp:get-tweak-store")
    .then((store) => {
      cachedStore = store;
      return store;
    })
    .finally(() => {
      if (storePromise === pending) storePromise = null;
    });
  storePromise = pending;
  return pending;
}

function renderStoreLoading(context: StorePageContext): void {
  const document = context.root.ownerDocument;
  context.root.textContent = "";
  const section = settingsSection(document, "Reviewed Tweaks", storeToolbar(context));
  const card = settingsCard(document);
  card.setAttribute("aria-busy", "true");
  card.appendChild(settingsMessageRow(document, "Loading Tweak Store", "Fetching the reviewed registry."));
  section.appendChild(card);
  context.root.appendChild(section);
}

function renderStore(context: StorePageContext, store: TweakStoreRegistryView): void {
  const document = context.root.ownerDocument;
  context.root.textContent = "";
  currentStoreUpdateCount = store.entries.filter((entry) =>
    entry.installed && entry.installed.version !== entry.manifest.version).length;
  context.setStoreUpdateCount(currentStoreUpdateCount);
  const section = settingsSection(document, "Reviewed Tweaks", storeToolbar(context));
  const source = document.createElement("div");
  source.textContent = `Refreshed ${new Date(store.fetchedAt).toLocaleString()}`;
  source.style.cssText = "font-size:12px;opacity:.65;";
  section.appendChild(source);
  if (store.entries.length === 0) {
    const card = settingsCard(document);
    card.appendChild(settingsMessageRow(document, "No tweaks yet", "Use Publish Tweak to submit the first one."));
    section.appendChild(card);
  } else {
    for (const entry of store.entries) section.appendChild(storeCard(context, entry));
  }
  context.root.appendChild(section);
}

function renderStoreError(context: StorePageContext, error: unknown): void {
  const document = context.root.ownerDocument;
  context.root.textContent = "";
  const section = settingsSection(document, "Reviewed Tweaks", storeToolbar(context));
  const alert = settingsMessageRow(document, "Could not load Tweak Store", errorMessage(error));
  alert.setAttribute("role", "alert");
  section.appendChild(alert);
  context.root.appendChild(section);
}

function storeToolbar(context: StorePageContext): HTMLElement {
  const document = context.root.ownerDocument;
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;align-items:center;gap:8px;";
  toolbar.appendChild(settingsButton(document, "Refresh", async () => {
    clearStoreCache();
    await renderStorePage(context, undefined, true);
  }));
  toolbar.appendChild(settingsButton(document, "Publish Tweak", async () => {
    const repo = context.promptRepo();
    if (!repo) return;
    const submission = await context.invoke<{ issueUrl: string }>("claudepp:prepare-tweak-submission", repo);
    await context.invoke("claudepp:open-external", submission.issueUrl);
  }));
  return toolbar;
}

function storeCard(context: StorePageContext, entry: TweakStoreEntryView): HTMLElement {
  const document = context.root.ownerDocument;
  const card = settingsCard(document);
  card.setAttribute("data-claudepp-store-entry", entry.id);
  card.style.padding = "14px";
  const title = document.createElement("div");
  title.textContent = `${entry.manifest.name} · Verified as safe`;
  title.style.fontWeight = "600";
  card.appendChild(title);
  if (entry.manifest.description) card.appendChild(settingsMessageRow(document, "", entry.manifest.description));
  const installed = entry.installed?.version;
  card.appendChild(settingsMessageRow(
    document,
    installed ? `Installed v${installed} · Latest v${entry.manifest.version}` : `Latest v${entry.manifest.version}`,
    `${entry.repo} · Approved ${entry.approvedAt || "reviewed commit"}`,
  ));
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:8px;";
  actions.appendChild(settingsButton(document, "Source", async () => {
    await context.invoke("claudepp:open-external", `https://github.com/${entry.repo}/tree/${entry.approvedCommitSha}`);
  }));
  if (entry.releaseUrl) {
    actions.appendChild(settingsButton(document, "Release", async () => {
      await context.invoke("claudepp:open-external", entry.releaseUrl);
    }));
  }
  const compatible = entry.platform.compatible && entry.runtime.compatible;
  const current = entry.installed?.version === entry.manifest.version;
  if (!entry.platform.compatible) {
    actions.appendChild(status(document, entry.platform.reason ?? "Unavailable on this platform"));
  } else if (!entry.runtime.compatible) {
    actions.appendChild(status(document, entry.runtime.reason ?? "Requires newer Claude++"));
  } else if (current) {
    actions.appendChild(status(document, "Installed"));
  } else if (compatible) {
    const label = entry.installed ? "Update" : "Install";
    const install = settingsButton(document, label, async () => {
      install.disabled = true;
      install.textContent = entry.installed ? "Updating" : "Installing";
      try {
        await context.invoke("claudepp:install-store-tweak", entry.id);
        actions.replaceChildren(status(document, "Installed"));
        currentStoreUpdateCount = Math.max(0, currentStoreUpdateCount - 1);
        context.setStoreUpdateCount(currentStoreUpdateCount);
        clearStoreCache();
        if (context.root.isConnected) {
          setTimeout(() => {
            if (context.root.isConnected) void renderStorePage(context, undefined, true);
          }, 900);
        }
      } catch (error) {
        install.disabled = false;
        install.textContent = label;
        const message = settingsMessageRow(document, "Install failed", errorMessage(error));
        message.setAttribute("role", "alert");
        card.appendChild(message);
      }
    });
    install.setAttribute("data-claudepp-store-install", entry.id);
    actions.appendChild(install);
  }
  card.appendChild(actions);
  return card;
}

function status(document: Document, label: string): HTMLElement {
  const badge = document.createElement("span");
  badge.textContent = label;
  badge.style.cssText = "padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.08);";
  return badge;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
