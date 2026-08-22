import assert from "node:assert/strict";

export class MiniElement {
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
    this.children.splice(0);
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
    return child;
  }

  public replaceChildren(...children: MiniElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.splice(0);
    this.append(...children);
  }

  public remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
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
}

interface MiniEvent {
  target: MiniElement;
  preventDefault(): void;
  stopPropagation(): void;
}

class MiniDocument extends MiniElement {
  public readonly documentElement = new MiniElement("html");
  public readonly body = new MiniElement("body");

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
    MiniMutationObserver.queueAttributeMutation(target, attributeName);
  }
}

class MiniMutationObserver {
  public static instances: MiniMutationObserver[] = [];
  private static readonly queued = new Set<MiniMutationObserver>();
  private observing = false;
  private target: MiniElement | null = null;
  private options: MutationObserverInit | null = null;

  public constructor(private readonly callback: () => void) {
    MiniMutationObserver.instances.push(this);
  }

  public observe(target: MiniElement, options: MutationObserverInit): void {
    this.observing = true;
    this.target = target;
    this.options = options;
  }

  public disconnect(): void {
    this.observing = false;
    MiniMutationObserver.queued.delete(this);
  }

  public static reset(): void {
    MiniMutationObserver.instances = [];
    MiniMutationObserver.queued.clear();
  }

  public static flush(): void {
    for (const instance of MiniMutationObserver.instances) {
      if (instance.observing) instance.callback();
    }
  }

  public static discardQueued(): void {
    MiniMutationObserver.queued.clear();
  }

  public static drainQueued(limit: number): { turns: number; pending: boolean } {
    let turns = 0;
    while (MiniMutationObserver.queued.size > 0 && turns < limit) {
      const queued = [...MiniMutationObserver.queued];
      MiniMutationObserver.queued.clear();
      for (const instance of queued) {
        if (instance.observing) instance.callback();
      }
      turns += 1;
    }
    return { turns, pending: MiniMutationObserver.queued.size > 0 };
  }

  public static queueAttributeMutation(target: MiniElement, attributeName: string): void {
    for (const instance of MiniMutationObserver.instances) {
      const options = instance.options;
      const observedTarget = instance.target;
      if (!instance.observing || !options?.attributes || !observedTarget) continue;
      if (options.attributeFilter && !options.attributeFilter.includes(attributeName)) continue;
      if (target !== observedTarget && (!options.subtree || !observedTarget.contains(target))) continue;
      MiniMutationObserver.queued.add(instance);
    }
  }

  public get observedOptions(): MutationObserverInit | null {
    return this.options;
  }

  public get isObserving(): boolean {
    return this.observing;
  }
}

class MiniResizeObserver {
  public static instances: MiniResizeObserver[] = [];
  private observing = false;

  public constructor(private readonly callback: () => void) {
    MiniResizeObserver.instances.push(this);
  }

  public observe(): void {
    this.observing = true;
  }

  public disconnect(): void {
    this.observing = false;
  }

  public static reset(): void {
    MiniResizeObserver.instances = [];
  }

  public static flush(): void {
    for (const instance of MiniResizeObserver.instances) {
      if (instance.observing) instance.callback();
    }
  }

  public get isObserving(): boolean {
    return this.observing;
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
  display?: string;
  visibility?: string;
  width?: number;
  height?: number;
}

export function settingsFixture(options: SettingsFixtureOptions = {}) {
  MiniMutationObserver.reset();
  MiniResizeObserver.reset();
  windowListeners.clear();
  const document = new MiniDocument();
  let dialog: MiniElement;
  let nav: MiniElement;
  let generalButton: MiniElement;
  let claudeCodeButton: MiniElement;
  let content: MiniElement;
  let nativeHeader: MiniElement;
  let nativeBody: MiniElement;
  let dialogDisplay = options.display ?? "block";
  let dialogVisibility = options.visibility ?? "visible";
  let dialogWidth = options.width ?? 800;
  let dialogHeight = options.height ?? 600;

  const mount = (): void => {
    dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-cds", "settings-dialog");
    nav = document.createElement("nav");
    const navBody = document.createElement("div");
    const nativeList = document.createElement("ul");
    generalButton = document.createElement("button");
    generalButton.textContent = "General";
    generalButton.className = [
      "flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors",
      "cursor-pointer bg-alpha-2 font-medium text-primary",
    ].join(" ");
    generalButton.setAttribute("aria-current", "page");
    claudeCodeButton = document.createElement("button");
    claudeCodeButton.textContent = "Claude Code";
    claudeCodeButton.className = [
      "flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors",
      "cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary",
    ].join(" ");
    nativeList.append(generalButton, claudeCodeButton);
    navBody.append(nativeList);
    nav.append(navBody);
    content = document.createElement("div");
    nativeHeader = document.createElement("header");
    nativeHeader.textContent = "Native heading";
    nativeHeader.style.display = "grid";
    nativeBody = document.createElement("main");
    nativeBody.textContent = "Native body";
    content.append(nativeHeader, nativeBody);
    dialog.append(nav, content);
    document.body.append(dialog);
  };
  mount();

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
      getComputedStyle: (_element: Element) => ({
        display: dialogDisplay,
        visibility: dialogVisibility,
      }),
      getBoundingClientRect: (_element: Element) => ({
        width: dialogWidth,
        height: dialogHeight,
      }),
      windowEvents: windowEvents as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    },
    get content() { return content; },
    get nativeHeader() { return nativeHeader; },
    get nativeBody() { return nativeBody; },
    get generalButton() { return generalButton; },
    get claudeCodeButton() { return claudeCodeButton; },
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
    },
    setDialogRect(width: number, height: number): void {
      dialogWidth = width;
      dialogHeight = height;
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
    mutationObservation(): MutationObserverInit | null {
      return MiniMutationObserver.instances[0]?.observedOptions ?? null;
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
