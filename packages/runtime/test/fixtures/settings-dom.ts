import assert from "node:assert/strict";

export class MiniElement {
  public readonly tagName: string;
  public readonly children: MiniElement[] = [];
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = { display: "" };
  public parentElement: MiniElement | null = null;
  public ownerDocument: MiniDocument | null = null;
  public className = "";
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

  public constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
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
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
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
}

class MiniMutationObserver {
  public static callbacks: Array<() => void> = [];

  public constructor(callback: () => void) {
    MiniMutationObserver.callbacks.push(callback);
  }

  public observe(): void {}
  public disconnect(): void {}
}

export function settingsFixture() {
  MiniMutationObserver.callbacks = [];
  const document = new MiniDocument();
  let dialog: MiniElement;
  let nav: MiniElement;
  let generalButton: MiniElement;
  let claudeCodeButton: MiniElement;
  let content: MiniElement;
  let nativeHeader: MiniElement;
  let nativeBody: MiniElement;

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
    groupLabels(): string[] {
      return document.querySelectorAll("[data-claudepp-settings-group-label]")
        .map((element) => element.textContent);
    },
    findPanel(): MiniElement | null {
      return document.querySelector("[data-claudepp-settings-panel]");
    },
    remountSettingsShell(): void {
      dialog.remove();
      mount();
    },
    flushMutation(): void {
      for (const callback of MiniMutationObserver.callbacks) callback();
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
