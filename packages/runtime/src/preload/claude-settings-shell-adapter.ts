export interface SettingsShellEnvironment {
  document: Document;
  MutationObserver: typeof MutationObserver;
  ResizeObserver: typeof ResizeObserver;
  getComputedStyle(element: Element): Pick<CSSStyleDeclaration, "display" | "visibility">;
  getBoundingClientRect(element: Element): Pick<DOMRect, "width" | "height">;
  windowEvents: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface SettingsNavigationItem {
  id: string;
  title: string;
  iconSvg?: string;
  badge?: string;
}

export interface SettingsNavigationGroup {
  id: string;
  title: string;
  items: SettingsNavigationItem[];
  headerAction?: SettingsNavigationHeaderAction;
}

export interface SettingsNavigationHeaderAction {
  id: string;
  label: string;
  title: string;
  onClick(): void | Promise<void>;
}

export interface SettingsShellAdapter {
  start(): void;
  stop(): void;
  setNavigation(
    groups: SettingsNavigationGroup[],
    activate: (id: string) => void,
    nativeRestored?: () => void,
  ): void;
  setNavigationMountListener(listener: (visible: boolean) => void): void;
  setVisibilityListener(listener: (visible: boolean) => void): void;
  setActive(id: string | null): void;
  showPanel(id: string, render: (root: HTMLElement) => void | (() => void)): void;
  restoreNative(): void;
}

interface SettingsShell {
  dialog: HTMLElement;
  nav: HTMLElement;
  navHost: HTMLElement;
  nativeButton: HTMLButtonElement;
  content: HTMLElement;
}

const activeNavigationClasses = ["bg-alpha-2", "font-medium", "text-primary"];
const inactiveNavigationClasses = [
  "text-secondary",
  "hover:bg-fill-ghost-hover",
  "hover:text-primary",
];

export function createClaudeSettingsShellAdapter(
  environment: SettingsShellEnvironment,
): SettingsShellAdapter {
  let started = false;
  let observer: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTarget: HTMLElement | null = null;
  let shell: SettingsShell | null = null;
  let groups: SettingsNavigationGroup[] = [];
  let groupElements: HTMLElement[] = [];
  let navigationKey: string | null = null;
  let activateNavigation: (id: string) => void = () => {};
  let notifyNativeRestored: () => void = () => {};
  let activeId: string | null = null;
  let activeRender: ((root: HTMLElement) => void | (() => void)) | null = null;
  let activeTeardown: (() => void) | null = null;
  let panel: HTMLElement | null = null;
  let documentClick: ((event: Event) => void) | null = null;
  let notifyNavigationMount: (visible: boolean) => void = () => {};
  let notifyVisibility: ((visible: boolean) => void) | null = null;
  let lastVisible = false;
  const hiddenNativeChildren = new Map<HTMLElement, string>();
  const onWindowResize = (): void => {
    if (started) publishVisibility();
  };

  function start(): void {
    if (started) return;
    started = true;
    observer = new environment.MutationObserver(() => {
      if (started) syncShell();
    });
    observer.observe(environment.document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
    });
    environment.windowEvents.addEventListener("resize", onWindowResize);
    documentClick = (event) => onDocumentClick(event);
    environment.document.addEventListener("click", documentClick, true);
    syncShell();
  }

  function stop(): void {
    if (!started && !shell) return;
    restoreNative();
    removeNavigationGroups();
    observer?.disconnect();
    observer = null;
    bindResizeObserver(null);
    environment.windowEvents.removeEventListener("resize", onWindowResize);
    if (documentClick) environment.document.removeEventListener("click", documentClick, true);
    documentClick = null;
    shell = null;
    groups = [];
    navigationKey = null;
    lastVisible = false;
    started = false;
  }

  function setNavigation(
    nextGroups: SettingsNavigationGroup[],
    activate: (id: string) => void,
    nativeRestored: () => void = () => {},
  ): void {
    groups = nextGroups;
    activateNavigation = activate;
    notifyNativeRestored = nativeRestored;
    if (activeId && !groups.some((group) => group.items.some((item) => item.id === activeId))) {
      restoreNative();
    }
    syncShell();
    syncNavigation();
  }

  function setNavigationMountListener(listener: (visible: boolean) => void): void {
    notifyNavigationMount = listener;
  }

  function setVisibilityListener(listener: (visible: boolean) => void): void {
    notifyVisibility = listener;
    lastVisible = isShellVisible(shell);
    listener(lastVisible);
  }

  function setActive(id: string | null): void {
    activeId = id;
    syncNavigationActiveState();
  }

  function showPanel(
    id: string,
    render: (root: HTMLElement) => void | (() => void),
  ): void {
    syncShell();
    runActiveTeardown();
    activeId = id;
    activeRender = render;
    renderActivePanel();
  }

  function restoreNative(): void {
    const wasActive = activeId !== null || activeRender !== null || panel !== null;
    runActiveTeardown();
    restoreShellDom();
    activeId = null;
    activeRender = null;
    syncNavigationActiveState();
    if (wasActive) notifyNativeRestored();
  }

  function syncShell(): void {
    const found = findSettingsShell(environment.document);
    if (!found) {
      if (shell) restoreNative();
      shell = null;
      removeNavigationGroups();
      bindResizeObserver(null);
      publishVisibility();
      return;
    }
    if (
      shell?.dialog === found.dialog &&
      shell.nav === found.nav &&
      shell.navHost === found.navHost &&
      shell.nativeButton === found.nativeButton &&
      shell.content === found.content &&
      groupElements.every((element) => found.dialog.contains(element))
    ) {
      syncNavigation();
      syncNavigationActiveState();
      publishVisibility();
      return;
    }

    const retainedId = activeId;
    const retainedRender = activeRender;
    runActiveTeardown();
    restoreShellDom();
    removeNavigationGroups();
    shell = found;
    bindResizeObserver(found.dialog);
    navigationKey = null;
    activeId = retainedId;
    activeRender = retainedRender;
    syncNavigation();
    if (activeId && activeRender) renderActivePanel();
    publishVisibility();
  }

  function syncNavigation(): void {
    if (!shell) return;
    const currentShell = shell;
    const desiredKey = groups.map((group) => [
      group.id,
      group.title,
      group.headerAction
        ? `${group.headerAction.id}|${group.headerAction.label}|${group.headerAction.title}`
        : "",
      ...group.items.map((item) => `${item.id}|${item.title}|${item.iconSvg ?? ""}|${item.badge ?? ""}`),
    ].join("\n")).join("\n---\n");
    const renderedGroupCount = groups.filter((group) => group.items.length > 0).length;
    const hadAttachedNavigation = groupElements.length > 0 &&
      groupElements.every((element) =>
        currentShell.dialog.contains(element) && currentShell.navHost.contains(element));
    const attached = groupElements.length === renderedGroupCount &&
      groupElements.every((element) =>
        currentShell.dialog.contains(element) && currentShell.navHost.contains(element));
    if (navigationKey === desiredKey && attached) return;

    removeNavigationGroups();
    for (const group of groups) {
      if (group.items.length === 0) continue;
      const container = environment.document.createElement("div");
      container.setAttribute("data-claudepp-settings-group", group.id);
      const heading = environment.document.createElement("div");
      heading.style.cssText = [
        "padding:12px 8px 4px",
        "font-size:11px",
        "font-weight:600",
        "display:flex",
        "align-items:center",
        "justify-content:space-between",
        "gap:8px",
      ].join(";");
      const label = environment.document.createElement("span");
      label.setAttribute("data-claudepp-settings-group-label", group.id);
      label.textContent = group.title;
      label.style.opacity = ".65";
      heading.appendChild(label);
      if (group.headerAction) heading.appendChild(createHeaderAction(group.id, group.headerAction));
      const list = environment.document.createElement("ul");
      for (const item of group.items) list.appendChild(createNavigationItem(item));
      container.append(heading, list);
      shell.navHost.appendChild(container);
      groupElements.push(container);
    }
    navigationKey = desiredKey;
    syncNavigationActiveState();
    if (groupElements.length > 0 && !hadAttachedNavigation) {
      notifyNavigationMount(isShellVisible(shell));
    }
  }

  function createHeaderAction(
    groupId: string,
    action: SettingsNavigationHeaderAction,
  ): HTMLButtonElement {
    const button = environment.document.createElement("button");
    button.type = "button";
    button.setAttribute("data-claudepp-settings-group-action", action.id);
    button.setAttribute("aria-label", action.title);
    button.title = action.title;
    button.textContent = action.label;
    Object.assign(button.style, {
      display: "inline-flex",
      height: "20px",
      borderRadius: "9999px",
      border: "0",
      background: "#0A84FF",
      color: "#FFFFFF",
      padding: "0 8px",
      fontSize: "10px",
      fontWeight: "700",
      lineHeight: "20px",
      letterSpacing: "0",
      textTransform: "none",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.18)",
    });
    button.addEventListener("mouseenter", () => {
      button.style.background = "#0071E3";
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "#0A84FF";
    });
    const actionId = action.id;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = groups.find((candidate) => candidate.id === groupId)?.headerAction;
      if (current?.id === actionId) void current.onClick();
    });
    return button;
  }

  function createNavigationItem(item: SettingsNavigationItem): HTMLLIElement {
    const row = environment.document.createElement("li");
    const button = environment.document.createElement("button");
    button.type = "button";
    button.className = shell?.nativeButton.className ?? "";
    button.setAttribute("data-claudepp-settings-page", item.id);
    button.setAttribute("aria-label", item.title);
    if (item.iconSvg) {
      const icon = environment.document.createElement("span");
      icon.setAttribute("data-claudepp-settings-icon", "true");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = item.iconSvg;
      button.appendChild(icon);
    }
    const label = environment.document.createElement("span");
    label.textContent = item.title;
    button.appendChild(label);
    if (item.badge) {
      const badge = environment.document.createElement("span");
      badge.setAttribute("data-claudepp-settings-badge", item.id);
      badge.textContent = item.badge;
      badge.style.cssText = [
        "margin-left:auto",
        "min-width:20px",
        "height:18px",
        "padding:0 6px",
        "border-radius:999px",
        "background:#d97757",
        "color:white",
        "font-size:11px",
        "line-height:18px",
        "text-align:center",
      ].join(";");
      button.appendChild(badge);
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activateNavigation(item.id);
    });
    row.appendChild(button);
    return row;
  }

  function syncNavigationActiveState(): void {
    if (!shell) return;
    for (const group of groupElements) {
      for (const button of Array.from(
        group.querySelectorAll<HTMLButtonElement>("[data-claudepp-settings-page]"),
      )) {
        setNavigationButtonActive(button, button.getAttribute("data-claudepp-settings-page") === activeId);
      }
    }
    if (!activeId) return;
    for (const button of Array.from(shell.nav.querySelectorAll<HTMLButtonElement>("button"))) {
      if (groupElements.some((group) => group.contains(button))) continue;
      if (button.getAttribute("aria-current") === "page" || hasAllClasses(button, activeNavigationClasses)) {
        setNavigationButtonActive(button, false);
      }
    }
  }

  function renderActivePanel(): void {
    if (!shell || !activeId || !activeRender) return;
    restoreShellDom();
    hideNativeContent();
    panel = environment.document.createElement("section");
    panel.setAttribute("data-claudepp-settings-panel", activeId);
    panel.style.cssText = "width:100%;height:100%;overflow:auto;padding:24px;box-sizing:border-box;";
    const root = environment.document.createElement("div");
    root.setAttribute("data-claudepp-settings-page-root", activeId);
    panel.appendChild(root);
    shell.content.appendChild(panel);
    try {
      const teardown = activeRender(root);
      activeTeardown = typeof teardown === "function" ? teardown : null;
    } catch (error) {
      const message = environment.document.createElement("div");
      message.setAttribute("role", "alert");
      message.textContent = `Unable to render this settings page: ${errorMessage(error)}`;
      root.appendChild(message);
    }
    syncNavigationActiveState();
  }

  function hideNativeContent(): void {
    if (!shell) return;
    for (const child of Array.from(shell.content.children) as HTMLElement[]) {
      if (child === panel) continue;
      if (!hiddenNativeChildren.has(child)) hiddenNativeChildren.set(child, child.style.display);
      child.style.display = "none";
    }
  }

  function restoreShellDom(): void {
    panel?.remove();
    panel = null;
    for (const [child, display] of hiddenNativeChildren) child.style.display = display;
    hiddenNativeChildren.clear();
  }

  function runActiveTeardown(): void {
    const teardown = activeTeardown;
    activeTeardown = null;
    if (!teardown) return;
    try {
      teardown();
    } catch {}
  }

  function removeNavigationGroups(): void {
    for (const group of groupElements) group.remove();
    groupElements = [];
    navigationKey = null;
  }

  function bindResizeObserver(dialog: HTMLElement | null): void {
    if (resizeTarget === dialog) return;
    resizeObserver?.disconnect();
    resizeObserver = null;
    resizeTarget = dialog;
    if (!dialog) return;
    resizeObserver = new environment.ResizeObserver(() => {
      if (started) publishVisibility();
    });
    resizeObserver.observe(dialog);
  }

  function isShellVisible(candidate: SettingsShell | null): boolean {
    if (!candidate?.dialog.isConnected) return false;
    const style = environment.getComputedStyle(candidate.dialog);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = environment.getBoundingClientRect(candidate.dialog);
    return rect.width > 0 && rect.height > 0;
  }

  function publishVisibility(): void {
    const visible = isShellVisible(shell);
    if (visible === lastVisible) return;
    lastVisible = visible;
    notifyVisibility?.(visible);
  }

  function onDocumentClick(event: Event): void {
    if (!shell || !activeId) return;
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const control = target?.closest?.("button,a,[role='link']");
    if (!control || !shell.nav.contains(control as Node)) return;
    if (groupElements.some((group) => group.contains(control as Node))) return;
    restoreNative();
  }

  return {
    start,
    stop,
    setNavigation,
    setNavigationMountListener,
    setVisibilityListener,
    setActive,
    showPanel,
    restoreNative,
  };
}

function findSettingsShell(document: Document): SettingsShell | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][data-cds]');
  for (const dialog of Array.from(dialogs)) {
    const directChildren = Array.from(dialog.children) as HTMLElement[];
    const nav = directChildren.find((child) => child.tagName === "NAV");
    const content = directChildren.find((child) => child !== nav && child.tagName === "DIV");
    if (!nav || !content) continue;
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>("button"));
    const labels = buttons.map((button) => compactLabel(button.textContent));
    const nativeButton = buttons.find((button) => compactLabel(button.textContent) === "Claude Code");
    if (!nativeButton || !labels.includes("General")) continue;
    const nativeList = nativeButton.closest("ul");
    const navHost = nativeList?.parentElement;
    if (!navHost || navHost.tagName !== "DIV") continue;
    return { dialog, nav, navHost, nativeButton, content };
  }
  return null;
}

function setNavigationButtonActive(button: HTMLButtonElement, active: boolean): void {
  const classes = new Set(button.className.split(/\s+/).filter(Boolean));
  const remove = active ? inactiveNavigationClasses : activeNavigationClasses;
  const add = active ? activeNavigationClasses : inactiveNavigationClasses;
  for (const className of remove) classes.delete(className);
  for (const className of add) classes.add(className);
  const nextClassName = [...classes].join(" ");
  if (button.className !== nextClassName) button.className = nextClassName;
  if (active) {
    if (button.getAttribute("aria-current") !== "page") button.setAttribute("aria-current", "page");
  } else if (button.hasAttribute("aria-current")) {
    button.removeAttribute("aria-current");
  }
}

function hasAllClasses(button: HTMLButtonElement, required: string[]): boolean {
  const classes = new Set(button.className.split(/\s+/).filter(Boolean));
  return required.every((className) => classes.has(className));
}

function compactLabel(value: string | null): string {
  return (value ?? "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
