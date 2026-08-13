import type {
  SettingsHandle,
  SettingsPage,
  SettingsSection,
  TweakManifest,
} from "@claude-plusplus/sdk";
import type {
  SettingsNavigationGroup,
  SettingsShellAdapter,
} from "../preload/claude-settings-shell-adapter.js";
import type {
  BuiltInSettingsRoute,
  ListedTweakView,
  RegisteredSettingsPage,
  RegisteredSettingsSection,
  SettingsProductPageContext,
  SettingsProductPageRenderer,
  SettingsProductServices,
} from "./types.js";

export type {
  BuiltInSettingsRoute,
  ListedTweakView,
  RegisteredSettingsPage,
  RegisteredSettingsSection,
  SettingsProductPageContext,
  SettingsProductServices,
} from "./types.js";

interface BuiltInPageDefinition {
  id: BuiltInSettingsRoute;
  title: string;
  heading: string;
  description: string;
  iconSvg: string;
  badge?: string;
  render: SettingsProductPageRenderer;
}

export class SettingsProductController {
  private readonly sections = new Map<string, RegisteredSettingsSection>();
  private readonly pages = new Map<string, RegisteredSettingsPage>();
  private listedTweaks: ListedTweakView[] = [];
  private activeId: string | null = null;
  private storeUpdateCount = 0;
  private started = false;

  public constructor(
    private readonly adapter: SettingsShellAdapter,
    private readonly services: SettingsProductServices,
  ) {}

  public start(): void {
    if (!this.started) {
      this.started = true;
      this.adapter.start();
    }
    this.syncNavigation();
  }

  public clear(): void {
    const activeId = this.activeId;
    this.sections.clear();
    this.pages.clear();
    if (activeId && !isBuiltInRoute(activeId)) {
      this.activeId = null;
      if (this.started) this.adapter.restoreNative();
    }
    this.syncNavigation();
    if (activeId === "claudepp:tweaks") this.activate(activeId);
  }

  public setListedTweaks(tweaks: ListedTweakView[]): void {
    this.listedTweaks = [...tweaks];
    if (this.activeId === "claudepp:tweaks") this.activate(this.activeId);
  }

  public setStoreUpdateCount(count: number): void {
    const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (this.storeUpdateCount === normalized) return;
    this.storeUpdateCount = normalized;
    this.syncNavigation();
  }

  public registerSection(tweakId: string, section: SettingsSection): SettingsHandle {
    const id = namespacedId(tweakId, section.id);
    const entry: RegisteredSettingsSection = { id, tweakId, section };
    this.sections.set(id, entry);
    if (this.activeId === "claudepp:tweaks") this.activate(this.activeId);

    let registered = true;
    return {
      unregister: (): void => {
        if (!registered) return;
        registered = false;
        if (this.sections.get(id) !== entry) return;
        this.sections.delete(id);
        if (this.activeId === "claudepp:tweaks") this.activate(this.activeId);
      },
    };
  }

  public registerPage(
    tweakId: string,
    manifest: TweakManifest,
    page: SettingsPage,
  ): SettingsHandle {
    const id = namespacedId(tweakId, page.id);
    const entry: RegisteredSettingsPage = { id, tweakId, manifest, page };
    this.pages.set(id, entry);
    this.syncNavigation();
    if (this.activeId === id) this.activate(id);

    let registered = true;
    return {
      unregister: (): void => {
        if (!registered) return;
        registered = false;
        if (this.pages.get(id) !== entry) return;
        this.pages.delete(id);
        if (this.activeId === id) {
          this.activeId = null;
          this.adapter.restoreNative();
        }
        this.syncNavigation();
      },
    };
  }

  public activate(id: string): void {
    const registered = this.pages.get(id);
    const builtIn = this.builtInPages().find((page) => page.id === id);
    if (!registered && !builtIn) {
      this.activeId = null;
      this.adapter.restoreNative();
      return;
    }

    this.activeId = id;
    if (registered) {
      this.adapter.showPanel(id, (root) => this.renderRegisteredPage(root, registered));
      return;
    }
    this.adapter.showPanel(id, (root) => this.renderBuiltInPage(root, builtIn!));
  }

  private syncNavigation(): void {
    if (!this.started) return;
    const groups: SettingsNavigationGroup[] = [{
      id: "claudepp",
      title: "CLAUDE++",
      items: this.builtInPages().map(({ id, title, iconSvg, badge }) => ({
        id,
        title,
        iconSvg,
        ...(badge ? { badge } : {}),
      })),
    }];
    if (this.pages.size > 0) {
      groups.push({
        id: "tweaks",
        title: "TWEAKS",
        items: [...this.pages.values()].map((entry) => ({
          id: entry.id,
          title: entry.page.title,
          iconSvg: entry.page.iconSvg ?? defaultPageIconSvg(),
        })),
      });
    }
    this.adapter.setNavigation(groups, (id) => this.activate(id), () => {
      this.activeId = null;
    });
    this.adapter.setActive(this.activeId);
  }

  private builtInPages(): BuiltInPageDefinition[] {
    return [
      {
        id: "claudepp:config",
        title: "Config",
        heading: "Claude++",
        description: "Checking installed Claude++ version.",
        iconSvg: configIconSvg(),
        render: this.services.renderConfig,
      },
      {
        id: "claudepp:tweaks",
        title: "Tweaks",
        heading: "Tweaks",
        description: "Manage your installed Claude++ tweaks.",
        iconSvg: tweaksIconSvg(),
        render: this.services.renderTweaks,
      },
      {
        id: "claudepp:store",
        title: "Tweak Store",
        heading: "Tweak Store",
        description: "Install reviewed tweaks pinned to approved GitHub commits.",
        iconSvg: storeIconSvg(),
        ...(this.storeUpdateCount > 0 ? { badge: String(this.storeUpdateCount) } : {}),
        render: this.services.renderStore,
      },
    ];
  }

  private renderRegisteredPage(
    root: HTMLElement,
    entry: RegisteredSettingsPage,
  ): void | (() => void) {
    const body = appendPageShell(root, entry.page.title, entry.page.description);
    return entry.page.render(body);
  }

  private renderBuiltInPage(
    root: HTMLElement,
    page: BuiltInPageDefinition,
  ): void | (() => void) {
    const body = appendPageShell(root, page.heading, page.description);
    const context: SettingsProductPageContext = {
      root: body,
      listedTweaks: this.listedTweaks,
      sections: [...this.sections.values()],
      pages: [...this.pages.values()],
      activate: (id) => this.activate(id),
      setStoreUpdateCount: (count) => this.setStoreUpdateCount(count),
    };
    try {
      return page.render(context);
    } catch (error) {
      const alert = root.ownerDocument.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = `Unable to load ${page.title}: ${errorMessage(error)}`;
      body.appendChild(alert);
    }
  }
}

export function createLoadingSettingsProductServices(): SettingsProductServices {
  const renderLoading = ({ root }: SettingsProductPageContext): void => {
    const row = root.ownerDocument.createElement("div");
    row.setAttribute("data-claudepp-settings-loading", "true");
    row.textContent = "Loading…";
    root.appendChild(row);
  };
  return {
    renderConfig: renderLoading,
    renderTweaks: renderLoading,
    renderStore: renderLoading,
  };
}

function appendPageShell(
  root: HTMLElement,
  titleText: string,
  descriptionText?: string,
): HTMLElement {
  const document = root.ownerDocument;
  const title = document.createElement("h1");
  title.textContent = titleText;
  root.appendChild(title);
  if (descriptionText) {
    const description = document.createElement("p");
    description.textContent = descriptionText;
    root.appendChild(description);
  }
  const body = document.createElement("div");
  body.setAttribute("data-claudepp-settings-page-body", "true");
  root.appendChild(body);
  return body;
}

function namespacedId(tweakId: string, localId: string): string {
  const prefix = `${tweakId}:`;
  return localId.startsWith(prefix) ? localId : `${prefix}${localId}`;
}

function isBuiltInRoute(id: string): id is BuiltInSettingsRoute {
  return id === "claudepp:config" || id === "claudepp:tweaks" || id === "claudepp:store";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configIconSvg(): string {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h9M15 5h2M3 10h2M8 10h9M3 15h11M17 15h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="13" cy="5" r="1.6" fill="currentColor"/><circle cx="6" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="15" r="1.6" fill="currentColor"/></svg>';
}

function tweaksIconSvg(): string {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 11.4 8.6 17.5 10 11.4 11.4 10 17.5 8.6 11.4 2.5 10 8.6 8.6Z" fill="currentColor"/><path d="m15.5 3 .5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5Z" fill="currentColor" opacity=".7"/></svg>';
}

function storeIconSvg(): string {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 8.2 1.1-3.7a1.5 1.5 0 0 1 1.45-1.1h6.9a1.5 1.5 0 0 1 1.45 1.1L16 8.2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M4.5 8h11v7.5A1.5 1.5 0 0 1 14 17H6a1.5 1.5 0 0 1-1.5-1.5V8Z" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 8v1a2.5 2.5 0 0 0 5 0V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}

function defaultPageIconSvg(): string {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.5"/><path d="M12 3v3a1 1 0 0 0 1 1h2M7 11h6M7 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}
