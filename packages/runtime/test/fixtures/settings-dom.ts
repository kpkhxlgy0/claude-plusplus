import assert from "node:assert/strict";

export class MiniElement {
  public readonly nodeType = 1;
  public readonly tagName: string;
  public readonly children: MiniElement[] = [];
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = { display: "" };
  public parentElement: MiniElement | null = null;
  public ownerDocument: MiniDocument | null = null;
  public disabled = false;
  public hidden = false;
  public innerHTML = "";
  public selected = false;
  public text = "";
  public title = "";
  public type = "";
  public value = "";
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: MiniEvent) => void>>();
  private currentClassName = "";

  public constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public get className(): string {
    return this.currentClassName;
  }

  public set className(value: string) {
    this.currentClassName = value;
    this.ownerDocument?.notifyAttributeMutation(this, "class");
  }

  public get isConnected(): boolean {
    return this.ownerDocument?.documentElement.contains(this) ?? false;
  }

  public get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  public set textContent(value: string) {
    this.text = value;
    const removed = [...this.children];
    for (const child of removed) child.parentElement = null;
    this.children.splice(0);
    this.ownerDocument?.notifyChildMutation(this, [], removed);
  }

  public get childElementCount(): number {
    return this.children.length;
  }

  public append(...children: MiniElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  public appendChild(child: MiniElement): MiniElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    this.ownerDocument?.notifyChildMutation(this, [child], []);
    return child;
  }

  public replaceChildren(...children: MiniElement[]): void {
    const removed = [...this.children];
    for (const child of removed) child.parentElement = null;
    this.children.splice(0);
    this.ownerDocument?.notifyChildMutation(this, [], removed);
    this.append(...children);
  }

  public remove(): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
    this.ownerDocument?.notifyChildMutation(parent, [], [this]);
  }

  public contains(candidate: MiniElement | null): boolean {
    for (let current = candidate; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    this.ownerDocument?.notifyAttributeMutation(this, name);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
    this.ownerDocument?.notifyAttributeMutation(this, name);
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  public addEventListener(type: string, listener: (event: MiniEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: MiniEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public emit(type: string, event: MiniEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  public querySelectorAll(selector: string): MiniElement[] {
    const matches: MiniElement[] = [];
    const visit = (node: MiniElement): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  public querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  public closest(selector: string): MiniElement | null {
    for (let current: MiniElement | null = this; current; current = current.parentElement) {
      if (matchesSelector(current, selector)) return current;
    }
    return null;
  }

  public matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }
}

interface MiniEvent {
  target: MiniElement;
  preventDefault(): void;
  stopPropagation(): void;
}

class MiniDocument extends MiniElement {
  public readonly documentElement = new MiniElement("html");
  public readonly body = new MiniElement("body");
  public queryCount = 0;

  public constructor() {
    super("document");
    this.ownerDocument = this;
    this.documentElement.ownerDocument = this;
    this.body.ownerDocument = this;
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  public createElement(tagName: string): MiniElement {
    const element = new MiniElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  public notifyAttributeMutation(target: MiniElement, attributeName: string): void {
    MiniMutationObserver.queue({ type: "attributes", target, attributeName, addedNodes: [], removedNodes: [] });
  }

  public notifyChildMutation(target: MiniElement, addedNodes: MiniElement[], removedNodes: MiniElement[]): void {
    if (addedNodes.length || removedNodes.length) {
      MiniMutationObserver.queue({ type: "childList", target, addedNodes, removedNodes });
    }
  }

  public override querySelectorAll(selector: string): MiniElement[] {
    this.queryCount += 1;
    return super.querySelectorAll(selector);
  }
}

interface MiniMutationRecord {
  type: "attributes" | "childList";
  target: MiniElement;
  attributeName?: string;
  addedNodes: MiniElement[];
  removedNodes: MiniElement[];
}

class MiniMutationObserver {
  public static instances: MiniMutationObserver[] = [];
  private static readonly queued = new Set<MiniMutationObserver>();
  private readonly targets = new Map<MiniElement, MutationObserverInit>();
  private records: MiniMutationRecord[] = [];

  public constructor(private readonly callback: (records: MiniMutationRecord[]) => void) {
    MiniMutationObserver.instances.push(this);
  }

  public observe(target: MiniElement, options: MutationObserverInit): void {
    this.targets.set(target, options);
  }

  public disconnect(): void {
    this.targets.clear();
    this.records = [];
    MiniMutationObserver.queued.delete(this);
  }

  public static reset(): void {
    MiniMutationObserver.instances = [];
    MiniMutationObserver.queued.clear();
  }

  public static flush(): void {
    assert.equal(this.drainQueued(50).pending, false);
  }

  public static discardQueued(): void {
    for (const instance of this.queued) instance.records = [];
    MiniMutationObserver.queued.clear();
  }

  public static drainQueued(limit: number): { turns: number; pending: boolean } {
    let turns = 0;
    while (MiniMutationObserver.queued.size > 0 && turns < limit) {
      const queued = [...MiniMutationObserver.queued];
      MiniMutationObserver.queued.clear();
      for (const instance of queued) {
        const records = instance.records;
        instance.records = [];
        if (records.length) instance.callback(records);
      }
      turns += 1;
    }
    return { turns, pending: MiniMutationObserver.queued.size > 0 };
  }

  public static queue(record: MiniMutationRecord): void {
    for (const instance of MiniMutationObserver.instances) {
      const matches = [...instance.targets].some(([target, options]) => {
        if (record.target !== target && (!options.subtree || !target.contains(record.target))) return false;
        if (record.type === "childList") return options.childList;
        return options.attributes && (!options.attributeFilter || options.attributeFilter.includes(record.attributeName!));
      });
      if (!matches) continue;
      instance.records.push(record);
      MiniMutationObserver.queued.add(instance);
    }
  }

  public get isObserving(): boolean {
    return this.targets.size > 0;
  }
}

class MiniResizeObserver {
  public static instances: MiniResizeObserver[] = [];
  private readonly targets = new Set<MiniElement>();

  public constructor(private readonly callback: () => void) {
    MiniResizeObserver.instances.push(this);
  }

  public observe(target: MiniElement): void {
    this.targets.add(target);
  }

  public unobserve(target: MiniElement): void {
    this.targets.delete(target);
  }

  public disconnect(): void {
    this.targets.clear();
  }

  public static reset(): void {
    MiniResizeObserver.instances = [];
  }

  public static flush(): void {
    for (const instance of MiniResizeObserver.instances) {
      if (instance.isObserving) instance.callback();
    }
  }

  public get isObserving(): boolean {
    return this.targets.size > 0;
  }
}

const windowListeners = new Map<string, Set<() => void>>();

const windowEvents = {
  addEventListener(type: string, listener: () => void) {
    const listeners = windowListeners.get(type) ?? new Set();
    listeners.add(listener);
    windowListeners.set(type, listeners);
  },
  removeEventListener(type: string, listener: () => void) {
    windowListeners.get(type)?.delete(listener);
  },
};

interface SettingsFixtureOptions {
  layout?: "direct" | "contents" | "contents-with-top-row";
  nativeNavigation?: "legacy" | "test-id";
  nativeLabels?: { general: string; claudeCode: string; account: string };
  includeClaudeCode?: boolean;
  display?: string;
  visibility?: string;
  width?: number;
  height?: number;
  selectedButton?: "general" | "claude-code";
  selectedStyle?: "current" | "legacy";
  mountOnStart?: boolean;
}

export function settingsFixture(options: SettingsFixtureOptions = {}) {
  MiniMutationObserver.reset();
  MiniResizeObserver.reset();
  windowListeners.clear();
  const document = new MiniDocument();
  const chat = document.createElement("main");
  document.body.append(chat);
  let visibilityReads = 0;
  let dialog: MiniElement;
  let shellHost: MiniElement;
  let nav: MiniElement;
  let generalButton: MiniElement;
  let claudeCodeButton: MiniElement;
  let nativeHeading: MiniElement;
  let nativeList: MiniElement;
  let nativeIcon: MiniElement;
  let nativeLabel: MiniElement;
  let content: MiniElement;
  let nativeHeader: MiniElement;
  let nativeBody: MiniElement;
  let nativeTopRow: MiniElement | null;
  let dialogDisplay = options.display ?? "block";
  let dialogVisibility = options.visibility ?? "visible";
  let dialogWidth = options.width ?? 800;
  let dialogHeight = options.height ?? 600;

  const setNativeSelection = (selected: "general" | "claude-code", style: "current" | "legacy"): void => {
    for (const [id, button] of [["general", generalButton], ["claude-code", claudeCodeButton]] as const) {
      button.className = [
        "flex h-control w-full items-center gap-sm rounded px-sm text-left text-body cursor-pointer",
        id === selected
          ? style === "current"
            ? "bg-fill-ghost-selected font-medium text-primary"
            : "bg-alpha-2 font-medium text-primary"
          : "text-secondary hover:bg-fill-ghost-hover hover:text-primary",
      ].join(" ");
      if (id === selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  };

  const createNavigation = (): MiniElement => {
    const nextNav = document.createElement("nav");
    const navBody = document.createElement("div");
    nativeHeading = document.createElement("div");
    nativeHeading.className = "px-sm pt-md text-caption text-muted";
    nativeHeading.textContent = "Personal";
    nativeList = document.createElement("ul");
    nativeList.className = "flex flex-col gap-px";
    generalButton = document.createElement("button");
    const generalIcon = document.createElement("svg");
    generalIcon.className = "shrink-0 text-secondary";
    generalIcon.setAttribute("width", "20");
    generalIcon.setAttribute("height", "20");
    const generalLabel = document.createElement("span");
    generalLabel.className = "min-w-0 flex-1 truncate";
    generalLabel.textContent = options.nativeLabels?.general ??
      (options.nativeNavigation === "test-id" ? "Appearance" : "General");
    generalButton.append(generalIcon, generalLabel);
    claudeCodeButton = document.createElement("button");
    nativeIcon = document.createElement("svg");
    nativeIcon.className = "shrink-0 text-secondary";
    nativeIcon.setAttribute("width", "20");
    nativeIcon.setAttribute("height", "20");
    nativeLabel = document.createElement("span");
    nativeLabel.className = "min-w-0 flex-1 truncate";
    nativeLabel.textContent = options.nativeLabels?.claudeCode ??
      (options.nativeNavigation === "test-id" ? "Code" : "Claude Code");
    claudeCodeButton.append(nativeIcon, nativeLabel);
    setNativeSelection(options.selectedButton ?? "general", options.selectedStyle ?? "current");
    if (options.nativeNavigation === "test-id") {
      const appendRow = (id: string, button: MiniElement): void => {
        const row = document.createElement("li");
        row.setAttribute("data-testid", id);
        row.appendChild(button);
        nativeList.appendChild(row);
      };
      appendRow("general-settings", generalButton);
      const accountButton = document.createElement("button");
      accountButton.className = claudeCodeButton.className;
      accountButton.textContent = options.nativeLabels?.account ?? "Account";
      appendRow("account-settings", accountButton);
      if (options.includeClaudeCode !== false) appendRow("claude-code-settings", claudeCodeButton);
    } else {
      nativeList.append(generalButton, claudeCodeButton);
    }
    navBody.append(nativeHeading, nativeList);
    nextNav.append(navBody);
    nav = nextNav;
    return nextNav;
  };

  const createDialog = (nativePortal = false): MiniElement => {
    dialog = document.createElement("div");
    shellHost = dialog;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-cds", nativePortal ? "Dialog" : "settings-dialog");
    if (nativePortal) dialog.setAttribute("data-perf-overlay", "settings_modal");
    return dialog;
  };

  const mountWrapper = (): void => {
    if (shellHost === dialog && (options.layout === "contents" || options.layout === "contents-with-top-row")) {
      shellHost = document.createElement("div");
      shellHost.className = "contents";
      dialog.appendChild(shellHost);
    }
  };

  const mountContents = (): void => {
    mountWrapper();
    createNavigation();
    content = document.createElement("div");
    if (options.layout === "contents" || options.layout === "contents-with-top-row") {
      content.className = "flex min-h-0 min-w-0 flex-1 flex-col bg-surface-2";
    }
    nativeHeader = document.createElement("header");
    nativeHeader.textContent = "Native heading";
    nativeHeader.style.display = "grid";
    nativeBody = document.createElement("main");
    nativeBody.textContent = "Native body";
    content.append(nativeHeader, nativeBody);
    nativeTopRow = null;
    shellHost.appendChild(nav);
    if (options.layout === "contents-with-top-row") {
      nativeTopRow = document.createElement("div");
      const heading = document.createElement("span");
      heading.textContent = "Settings";
      nativeTopRow.appendChild(heading);
      shellHost.appendChild(nativeTopRow);
    }
    shellHost.appendChild(content);
  };

  const mount = (): void => {
    createDialog();
    mountContents();
    document.body.append(dialog);
  };
  if (options.mountOnStart !== false) mount();

  const click = (target: MiniElement | null): void => {
    assert.ok(target);
    const event: MiniEvent = {
      target,
      preventDefault() {},
      stopPropagation() {},
    };
    target.emit("click", event);
    document.emit("click", event);
  };

  return {
    environment: {
      document: document as unknown as Document,
      MutationObserver: MiniMutationObserver as unknown as typeof MutationObserver,
      ResizeObserver: MiniResizeObserver as unknown as typeof ResizeObserver,
      getComputedStyle: (_element: Element) => {
        visibilityReads += 1;
        return { display: dialogDisplay, visibility: dialogVisibility };
      },
      getBoundingClientRect: (_element: Element) => ({
        width: dialogWidth,
        height: dialogHeight,
      }),
      windowEvents: windowEvents as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    },
    get content() { return content; },
    get nativeHeader() { return nativeHeader; },
    get nativeBody() { return nativeBody; },
    get nativeTopRow() { return nativeTopRow; },
    get generalButton() { return generalButton; },
    get claudeCodeButton() { return claudeCodeButton; },
    get nativeHeading() { return nativeHeading; },
    get nativeList() { return nativeList; },
    get nativeIcon() { return nativeIcon; },
    get nativeLabel() { return nativeLabel; },
    selectNativeButton(selected: "general" | "claude-code", style: "current" | "legacy" = "current"): void {
      setNativeSelection(selected, style);
    },
    click,
    button(id: string): MiniElement | null {
      return document.querySelector(`[data-claudepp-settings-page="${id}"]`);
    },
    findPageButton(id: string): MiniElement | null {
      return document.querySelector(`[data-claudepp-settings-page="${id}"]`);
    },
    countButtons(id: string): number {
      return document.querySelectorAll(`[data-claudepp-settings-page="${id}"]`).length;
    },
    countPageButtons(id: string): number {
      return document.querySelectorAll(`[data-claudepp-settings-page="${id}"]`).length;
    },
    groupAction(id: string): MiniElement | null {
      return document.querySelector(`[data-claudepp-settings-group-action="${id}"]`);
    },
    countGroupActions(id: string): number {
      return document.querySelectorAll(`[data-claudepp-settings-group-action="${id}"]`).length;
    },
    groupLabels(): string[] {
      return document.querySelectorAll("[data-claudepp-settings-group-label]")
        .map((element) => element.textContent);
    },
    findPanel(): MiniElement | null {
      return document.querySelector("[data-claudepp-settings-panel]");
    },
    setDialogStyle(next: { display: string; visibility: string }): void {
      dialogDisplay = next.display;
      dialogVisibility = next.visibility;
      dialog.setAttribute("style", `display:${next.display};visibility:${next.visibility}`);
    },
    setDialogRect(width: number, height: number): void {
      dialogWidth = width;
      dialogHeight = height;
    },
    setDialogClosed(closed: boolean): void {
      if (closed) dialog.setAttribute("data-closed", "");
      else dialog.removeAttribute("data-closed");
    },
    flushAttributeMutation(): void {
      MiniMutationObserver.flush();
    },
    flushResize(): void {
      MiniResizeObserver.flush();
    },
    flushWindowResize(): void {
      for (const listener of windowListeners.get("resize") ?? []) listener();
    },
    flushMutation(): void {
      MiniMutationObserver.flush();
    },
    queueObservedClassMutation(target: MiniElement): void {
      target.className = target.className;
    },
    discardQueuedMutations(): void {
      MiniMutationObserver.discardQueued();
    },
    drainQueuedMutations(limit: number): { turns: number; pending: boolean } {
      return MiniMutationObserver.drainQueued(limit);
    },
    settingsReadCounts() {
      return { documentQueries: document.queryCount, visibilityReads };
    },
    appendChatUpdate(): void {
      const turn = document.createElement("article");
      chat.append(turn);
      turn.className = "streaming";
      turn.setAttribute("style", "min-height: 100px");
      const reply = document.createElement("p");
      turn.append(reply);
      reply.textContent = "Claude is typing";
    },
    appendNativePortal(): MiniElement {
      const portal = document.createElement("div");
      portal.setAttribute("data-base-ui-portal", "");
      document.body.append(portal);
      return portal;
    },
    appendIncompleteSettingsDialog(portal: MiniElement, marked = true): void {
      const cdsPortal = document.createElement("div");
      cdsPortal.setAttribute("data-cds-portal", "");
      portal.append(cdsPortal);
      cdsPortal.append(createDialog(marked));
    },
    appendChatOverlay(portal: MiniElement, marked = true): MiniElement {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("data-cds", "Dialog");
      if (marked) overlay.setAttribute("data-perf-overlay", "chat_overlay");
      portal.append(overlay);
      return overlay;
    },
    mountSettingsWrapper: mountWrapper,
    mountSettingsContents: mountContents,
    removeNativeSettingsRows(): MiniElement[] {
      const rows = [...nativeList.children];
      nativeList.replaceChildren();
      return rows;
    },
    restoreNativeSettingsRows(rows: MiniElement[]): void {
      nativeList.append(...rows);
    },
    activeMutationObserverCount(): number {
      return MiniMutationObserver.instances.filter((instance) => instance.isObserving).length;
    },
    activeResizeObserverCount(): number {
      return MiniResizeObserver.instances.filter((instance) => instance.isObserving).length;
    },
    windowListenerCount(type: string): number {
      return windowListeners.get(type)?.size ?? 0;
    },
    removeSettingsShell(): void {
      dialog.remove();
    },
    replaceVisibleSettingsShell(): void {
      dialog.remove();
      dialogDisplay = "block";
      dialogVisibility = "visible";
      dialogWidth = 800;
      dialogHeight = 600;
      mount();
    },
    removeInjectedSettingsGroups(): void {
      for (const group of document.querySelectorAll("[data-claudepp-settings-group]")) group.remove();
    },
    remountSettingsNavigation(): void {
      nav.remove();
      shellHost.appendChild(createNavigation());
    },
    removeSettingsNavigation(): void {
      nav.remove();
    },
    restoreSettingsNavigation(): void {
      shellHost.appendChild(createNavigation());
    },
    remountSettingsShell(): void {
      dialog.remove();
      mount();
    },
  };
}

export function classTokens(element: MiniElement): string[] {
  return element.className.split(/\s+/).filter(Boolean).sort();
}

function matchesSelector(element: MiniElement, selector: string): boolean {
  if (/^[a-z]+$/i.test(selector)) return element.tagName === selector.toUpperCase();
  if (selector === "button") return element.tagName === "BUTTON";
  if (selector === "button,a,[role='link']") {
    return element.tagName === "BUTTON" || element.tagName === "A" || element.getAttribute("role") === "link";
  }
  if (selector === "nav") return element.tagName === "NAV";
  if (selector === "ul") return element.tagName === "UL";
  if (selector === "[role=\"dialog\"][data-cds]") {
    return element.getAttribute("role") === "dialog" && element.hasAttribute("data-cds");
  }
  for (const attribute of [
    "data-claudepp-settings-panel",
    "data-claudepp-settings-icon",
    "data-claudepp-settings-group",
    "data-claudepp-settings-group-label",
    "data-claudepp-settings-group-action",
    "data-claudepp-settings-badge",
  ]) {
    if (selector === `[${attribute}]`) return element.hasAttribute(attribute);
  }
  const page = /^\[data-claudepp-settings-page="([^"]+)"\]$/.exec(selector);
  if (page) return element.getAttribute("data-claudepp-settings-page") === page[1];
  const attributeValue = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
  if (attributeValue) return element.getAttribute(attributeValue[1]) === attributeValue[2];
  const attribute = /^\[([^=\]]+)\]$/.exec(selector);
  return attribute ? element.hasAttribute(attribute[1]) : false;
}
