import type { TweakManifest } from "@claude-plusplus/sdk";
import type {
  ListedTweakView,
  RegisteredSettingsPage,
  RegisteredSettingsSection,
  SettingsProductPageContext,
} from "./types.js";
import {
  settingsButton,
  settingsCard,
  settingsMessageRow,
  settingsSection,
  settingsSwitch,
} from "./components.js";

export interface TweaksPageContext extends SettingsProductPageContext {
  tweaksPath: string;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  resolveIcon(tweak: ListedTweakView): Promise<string | null>;
}

export function renderTweaksPage(context: TweaksPageContext): () => void {
  const { root } = context;
  const document = root.ownerDocument;
  const teardowns: Array<() => void> = [];
  let disposed = false;
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:8px;";
  actions.appendChild(settingsButton(document, "Force Reload", async () => {
    await invokeWithError(context, "claudepp:reload-tweaks");
  }));
  actions.appendChild(settingsButton(document, "Open Tweaks Folder", async () => {
    await invokeWithError(context, "claudepp:reveal", context.tweaksPath);
  }));

  const section = settingsSection(document, "Installed Tweaks", actions);
  if (context.listedTweaks.length === 0) {
    const card = settingsCard(document);
    card.appendChild(settingsMessageRow(
      document,
      "No tweaks installed",
      `Drop a tweak folder into ${context.tweaksPath} and reload.`,
    ));
    section.appendChild(card);
    root.appendChild(section);
    return () => {};
  }

  const sectionsByTweak = groupSections(context.sections);
  const pagesByTweak = groupPages(context.pages);
  const card = settingsCard(document);
  for (const tweak of context.listedTweaks) {
    card.appendChild(renderTweakRow(
      context,
      tweak,
      sectionsByTweak.get(tweak.manifest.id) ?? [],
      pagesByTweak.get(tweak.manifest.id) ?? [],
      teardowns,
      () => disposed,
    ));
  }
  section.appendChild(card);
  root.appendChild(section);
  return () => {
    if (disposed) return;
    disposed = true;
    for (const teardown of teardowns.reverse()) {
      try { teardown(); } catch {}
    }
  };
}

function renderTweakRow(
  context: TweaksPageContext,
  tweak: ListedTweakView,
  sections: RegisteredSettingsSection[],
  pages: RegisteredSettingsPage[],
  teardowns: Array<() => void>,
  isDisposed: () => boolean,
): HTMLElement {
  const document = context.root.ownerDocument;
  const cell = document.createElement("div");
  cell.setAttribute("data-claudepp-tweak", tweak.manifest.id);
  cell.style.cssText = "display:flex;flex-direction:column;border-bottom:1px solid rgba(255,255,255,.08);";
  if (!tweak.enabled) cell.style.opacity = "0.7";
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px;";
  const left = document.createElement("div");
  left.style.cssText = "display:flex;align-items:flex-start;gap:12px;min-width:0;";
  left.appendChild(renderIcon(context, tweak, isDisposed));
  left.appendChild(renderMetadata(context, tweak));
  header.appendChild(left);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:8px;flex-shrink:0;";
  if (tweak.enabled && pages.length > 0) {
    actions.appendChild(settingsButton(document, "Configure", () => {
      context.activate(pages[0]!.id);
    }));
  }
  if (tweak.update?.updateAvailable && tweak.update.releaseUrl) {
    actions.appendChild(settingsButton(document, "Review Release", async () => {
      await invokeWithError(context, "claudepp:open-external", tweak.update!.releaseUrl);
    }));
  }
  const toggle = settingsSwitch(document, tweak.enabled, async (enabled) => {
    await invokeWithError(context, "claudepp:set-tweak-enabled", tweak.manifest.id, enabled);
  });
  if (!tweak.entryExists || !tweak.compatible) {
    toggle.disabled = true;
    toggle.setAttribute("aria-disabled", "true");
    toggle.setAttribute("title", tweak.issue ?? "Tweak cannot be loaded");
  }
  actions.appendChild(toggle);
  header.appendChild(actions);
  cell.appendChild(header);

  if (tweak.enabled && sections.length > 0) {
    const nested = document.createElement("div");
    nested.style.cssText = "display:flex;flex-direction:column;border-top:1px solid rgba(255,255,255,.08);";
    for (const entry of sections) {
      const body = document.createElement("div");
      body.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:14px;";
      const title = document.createElement("div");
      title.textContent = entry.section.title;
      title.style.fontWeight = "600";
      body.appendChild(title);
      if (entry.section.description) {
        const description = document.createElement("div");
        description.textContent = entry.section.description;
        description.style.opacity = "0.7";
        body.appendChild(description);
      }
      const sectionRoot = document.createElement("div");
      body.appendChild(sectionRoot);
      try {
        const teardown = entry.section.render(sectionRoot);
        if (typeof teardown === "function") teardowns.push(teardown);
      } catch (error) {
        const alert = document.createElement("div");
        alert.setAttribute("role", "alert");
        alert.textContent = `Error rendering tweak section: ${errorMessage(error)}`;
        sectionRoot.appendChild(alert);
      }
      nested.appendChild(body);
    }
    cell.appendChild(nested);
  }
  return cell;
}

function renderIcon(
  context: TweaksPageContext,
  tweak: ListedTweakView,
  isDisposed: () => boolean,
): HTMLElement {
  const document = context.root.ownerDocument;
  const avatar = document.createElement("div");
  avatar.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "width:48px",
    "height:48px",
    "border:1px solid rgba(255,255,255,.12)",
    "border-radius:8px",
    "overflow:hidden",
    "flex-shrink:0",
  ].join(";");
  const fallback = document.createElement("span");
  fallback.textContent = (tweak.manifest.name[0] ?? "?").toUpperCase();
  avatar.appendChild(fallback);
  if (!tweak.manifest.iconUrl) return avatar;
  const image = document.createElement("img");
  image.setAttribute("alt", "");
  image.style.cssText = "display:none;width:100%;height:100%;object-fit:contain;";
  avatar.appendChild(image);
  void context.resolveIcon(tweak).then((url) => {
    if (!url || isDisposed()) return;
    image.setAttribute("src", url);
    image.style.display = "block";
    fallback.remove();
  }).catch(() => {});
  return avatar;
}

function renderMetadata(context: TweaksPageContext, tweak: ListedTweakView): HTMLElement {
  const document = context.root.ownerDocument;
  const { manifest } = tweak;
  const stack = document.createElement("div");
  stack.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;";
  const title = document.createElement("div");
  title.textContent = `${manifest.name} v${manifest.version}`;
  title.style.fontWeight = "600";
  if (tweak.update?.updateAvailable) title.textContent += " Update Available";
  stack.appendChild(title);
  if (manifest.description) stack.appendChild(metadataLine(document, manifest.description));
  const details = document.createElement("div");
  details.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px;opacity:.7;";
  const author = authorName(manifest.author);
  if (author) appendMetadataText(document, details, author);
  if (manifest.githubRepo) {
    appendMetadataSeparator(document, details);
    const repository = metadataButton(document, manifest.githubRepo, async () => {
      await invokeWithError(context, "claudepp:open-external", `https://github.com/${manifest.githubRepo}`);
    });
    details.appendChild(repository);
  }
  if (manifest.homepage) {
    appendMetadataSeparator(document, details);
    const homepage = document.createElement("a");
    homepage.textContent = "Homepage";
    homepage.setAttribute("href", manifest.homepage);
    homepage.setAttribute("target", "_blank");
    homepage.setAttribute("rel", "noreferrer");
    details.appendChild(homepage);
  }
  if (details.childElementCount > 0) stack.appendChild(details);
  if (manifest.tags?.length) stack.appendChild(metadataLine(document, manifest.tags.join(" · ")));
  if (tweak.issue) stack.appendChild(metadataLine(document, tweak.issue));
  return stack;
}

function metadataLine(document: Document, text: string): HTMLElement {
  const line = document.createElement("div");
  line.textContent = text;
  line.style.cssText = "font-size:13px;opacity:.7;";
  return line;
}

function metadataButton(
  document: Document,
  label: string,
  onClick: () => void | Promise<void>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = "border:0;background:transparent;color:inherit;padding:0;cursor:pointer;";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void onClick();
  });
  return button;
}

function appendMetadataText(document: Document, root: HTMLElement, value: string): void {
  const text = document.createElement("span");
  text.textContent = value;
  root.appendChild(text);
}

function appendMetadataSeparator(document: Document, root: HTMLElement): void {
  if (root.childElementCount === 0) return;
  appendMetadataText(document, root, "·");
}

function groupSections(
  sections: readonly RegisteredSettingsSection[],
): Map<string, RegisteredSettingsSection[]> {
  const grouped = new Map<string, RegisteredSettingsSection[]>();
  for (const section of sections) {
    const items = grouped.get(section.tweakId) ?? [];
    items.push(section);
    grouped.set(section.tweakId, items);
  }
  return grouped;
}

function groupPages(pages: readonly RegisteredSettingsPage[]): Map<string, RegisteredSettingsPage[]> {
  const grouped = new Map<string, RegisteredSettingsPage[]>();
  for (const page of pages) {
    const items = grouped.get(page.tweakId) ?? [];
    items.push(page);
    grouped.set(page.tweakId, items);
  }
  return grouped;
}

async function invokeWithError(
  context: TweaksPageContext,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  try {
    await context.invoke(channel, ...args);
  } catch (error) {
    const alert = context.root.ownerDocument.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = errorMessage(error);
    context.root.appendChild(alert);
  }
}

function authorName(author: TweakManifest["author"]): string {
  if (!author) return "";
  return typeof author === "string" ? author : author.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
