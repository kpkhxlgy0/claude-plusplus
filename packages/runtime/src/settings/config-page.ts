import type { ClaudePlusPlusUpdateCheck } from "../config.js";
import type {
  ClaudePlusPlusConfigView,
  SelfUpdateStateView,
} from "../update-service.js";
import type {
  WatcherHealth,
  WatcherHealthCheck,
} from "../watcher-health.js";
import {
  settingsButton,
  settingsCard,
  settingsMessageRow,
  settingsSection,
  settingsSwitch,
} from "./components.js";

export interface ConfigPageContext {
  root: HTMLElement;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  publishProductUpdate(check: ClaudePlusPlusUpdateCheck | null): void;
}

export async function renderConfigPage(context: ConfigPageContext): Promise<() => void> {
  let disposed = false;
  renderLoading(context.root);
  try {
    const [config, watcher] = await Promise.all([
      context.invoke<ClaudePlusPlusConfigView>("claudepp:get-config"),
      context.invoke<WatcherHealth>("claudepp:get-watcher-health"),
    ]);
    if (!disposed) renderConfig(context, config, watcher);
  } catch (error) {
    if (!disposed) renderLoadError(context.root, error);
  }
  return () => { disposed = true; };
}

function renderLoading(root: HTMLElement): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const section = settingsSection(document, "Claude++ Updates");
  const card = settingsCard(document);
  card.appendChild(settingsMessageRow(document, "Loading update settings", "Checking current configuration."));
  section.appendChild(card);
  root.appendChild(section);
}

function renderLoadError(root: HTMLElement, error: unknown): void {
  const document = root.ownerDocument;
  root.textContent = "";
  const alert = settingsMessageRow(document, "Could not load Claude++ Config", errorMessage(error));
  alert.setAttribute("role", "alert");
  root.appendChild(alert);
}

function renderConfig(
  context: ConfigPageContext,
  config: ClaudePlusPlusConfigView,
  watcher: WatcherHealth,
): void {
  const { root } = context;
  const document = root.ownerDocument;
  root.textContent = "";
  root.appendChild(renderUpdatesSection(context, config, watcher));
  root.appendChild(renderWatcherSection(context, watcher));
  root.appendChild(renderMaintenanceSection(context));
}

function renderUpdatesSection(
  context: ConfigPageContext,
  config: ClaudePlusPlusConfigView,
  watcher: WatcherHealth,
): HTMLElement {
  const document = context.root.ownerDocument;
  const section = settingsSection(document, "Claude++ Updates");
  const card = settingsCard(document);
  const automatic = actionRow(
    document,
    "Automatically refresh Claude++",
    watcher.installed
      ? `Installed version v${config.version}. The Watcher checks at logon and every five minutes.`
      : "Enable Watcher before automatic refresh can be used.",
  );
  const automaticToggle = settingsSwitch(document, config.autoUpdate, async (enabled) => {
    await context.invoke("claudepp:set-auto-update", enabled);
    await renderConfigPage(context);
  }, "data-claudepp-auto-update");
  automaticToggle.disabled = !watcher.installed;
  automatic.actions.appendChild(automaticToggle);
  card.appendChild(automatic.row);
  card.appendChild(updateChannelRow(context, config));
  if (config.updateChannel === "custom") {
    card.appendChild(settingsMessageRow(
      document,
      "Custom source trust boundary",
      "Custom can build arbitrary GitHub source and requires a trusted system Node.js 24+ installation.",
    ));
  }
  card.appendChild(settingsMessageRow(
    document,
    "Installation source",
    `${config.installationSource.label}: ${config.installationSource.detail}`,
  ));
  card.appendChild(settingsMessageRow(document, "Last Claude++ update", selfUpdateSummary(config.selfUpdate)));
  card.appendChild(updateActionsRow(context, config));
  if (config.updateCheck) card.appendChild(releaseNotesRow(document, config.updateCheck));
  section.appendChild(card);
  return section;
}

function updateChannelRow(context: ConfigPageContext, config: ClaudePlusPlusConfigView): HTMLElement {
  const document = context.root.ownerDocument;
  const action = actionRow(document, "Release channel", updateChannelSummary(config));
  const select = document.createElement("select");
  select.setAttribute("data-claudepp-update-channel", "true");
  for (const [value, label] of [
    ["stable", "Stable"],
    ["prerelease", "Prerelease"],
    ["custom", "Custom"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = config.updateChannel === value;
    select.appendChild(option);
  }
  select.value = config.updateChannel;
  select.addEventListener("change", () => {
    void context.invoke("claudepp:set-update-config", { updateChannel: select.value })
      .then(() => renderConfigPage(context));
  });
  action.actions.appendChild(select);
  if (config.updateChannel === "custom") {
    const repo = document.createElement("input");
    repo.value = config.updateRepo;
    repo.setAttribute("aria-label", "Custom GitHub repository");
    const ref = document.createElement("input");
    ref.value = config.updateRef;
    ref.setAttribute("aria-label", "Custom Git ref");
    action.actions.append(repo, ref, settingsButton(document, "Save", async () => {
      await context.invoke("claudepp:set-update-config", {
        updateChannel: "custom",
        updateRepo: repo.value,
        updateRef: ref.value,
      });
      await renderConfigPage(context);
    }));
  }
  return action.row;
}

function updateActionsRow(context: ConfigPageContext, config: ClaudePlusPlusConfigView): HTMLElement {
  const document = context.root.ownerDocument;
  const check = config.updateCheck;
  const action = actionRow(
    document,
    check?.updateAvailable ? "Claude++ update available" : "Check for Claude++ updates",
    updateSummary(check),
  );
  action.actions.appendChild(settingsButton(document, "Check Now", async () => {
    const result = await context.invoke<ClaudePlusPlusUpdateCheck>(
      "claudepp:check-claudepp-update",
      true,
    );
    context.publishProductUpdate(result);
    if (!context.root.isConnected) return;
    await renderConfigPage(context);
  }));
  if (check?.releaseUrl) {
    action.actions.appendChild(settingsButton(document, "Release Notes", async () => {
      await context.invoke("claudepp:open-external", check.releaseUrl);
    }));
  }
  action.actions.appendChild(settingsButton(document, "Download Update", async () => {
    await context.invoke("claudepp:run-claudepp-update");
    await renderConfigPage(context);
  }));
  return action.row;
}

function renderWatcherSection(context: ConfigPageContext, health: WatcherHealth): HTMLElement {
  const document = context.root.ownerDocument;
  const section = settingsSection(document, "Auto-Repair Watcher");
  const card = settingsCard(document);
  const action = actionRow(document, health.title, health.summary);
  action.actions.appendChild(settingsButton(document, "Check Now", async () => {
    await renderConfigPage(context);
  }));
  action.actions.appendChild(settingsButton(
    document,
    health.installed ? "Disable Watcher" : "Enable Watcher",
    async () => {
      await context.invoke("claudepp:set-watcher-enabled", !health.installed);
      await renderConfigPage(context);
    },
  ));
  card.appendChild(action.row);
  for (const check of health.checks) {
    if (check.status !== "ok") card.appendChild(watcherCheckRow(document, check));
  }
  section.appendChild(card);
  return section;
}

function watcherCheckRow(document: Document, check: WatcherHealthCheck): HTMLElement {
  return settingsMessageRow(document, `${statusLabel(check.status)} · ${check.name}`, check.detail);
}

function renderMaintenanceSection(context: ConfigPageContext): HTMLElement {
  const document = context.root.ownerDocument;
  const section = settingsSection(document, "Maintenance");
  const card = settingsCard(document);
  const uninstall = actionRow(
    document,
    "Uninstall Claude++",
    "Copy the uninstall command and run it after quitting Claude Desktop.",
  );
  const command = '& "$env:USERPROFILE\\.claude-plusplus\\source\\toolchain\\node.exe" ' +
    '"$env:USERPROFILE\\.claude-plusplus\\source\\packages\\installer\\dist\\cli.js" uninstall';
  uninstall.actions.appendChild(settingsButton(document, "Copy Command", async () => {
    await context.invoke("claudepp:copy-text", command);
  }));
  card.appendChild(uninstall.row);
  const issue = actionRow(document, "Report a bug", "Open a GitHub issue with Claude++ diagnostics.");
  issue.actions.appendChild(settingsButton(document, "Open Issue", async () => {
    await context.invoke(
      "claudepp:open-external",
      "https://github.com/kpkhxlgy0/claude-plusplus/issues/new?template=bug-report.md",
    );
  }));
  card.appendChild(issue.row);
  section.appendChild(card);
  return section;
}

function releaseNotesRow(document: Document, check: ClaudePlusPlusUpdateCheck): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:14px;";
  const title = document.createElement("div");
  title.textContent = "Latest release notes";
  title.style.fontWeight = "600";
  row.appendChild(title);
  row.appendChild(renderReleaseNotesMarkdown(document, check.releaseNotes?.trim() || check.error ||
    "No release notes available."));
  return row;
}

export function renderReleaseNotesMarkdown(document: Document, markdown: string): HTMLElement {
  const root = document.createElement("div");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: HTMLOListElement | HTMLUListElement | null = null;
  let code: string[] | null = null;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const element = document.createElement("p");
    appendInlineMarkdown(document, element, paragraph.join(" ").trim());
    root.appendChild(element);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    root.appendChild(list);
    list = null;
  };
  const flushCode = (): void => {
    if (!code) return;
    const pre = document.createElement("pre");
    const codeElement = document.createElement("code");
    codeElement.textContent = code.join("\n");
    pre.appendChild(codeElement);
    root.appendChild(pre);
    code = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      if (code) flushCode();
      else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const element = document.createElement(heading[1].length === 1 ? "h3" : "h4");
      appendInlineMarkdown(document, element, heading[2]);
      root.appendChild(element);
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      if (!list || (orderedList && list.tagName !== "OL") || (!orderedList && list.tagName !== "UL")) {
        flushList();
        list = document.createElement(orderedList ? "ol" : "ul");
      }
      const element = document.createElement("li");
      appendInlineMarkdown(document, element, (unordered ?? ordered)?.[1] ?? "");
      list.appendChild(element);
      continue;
    }
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      const element = document.createElement("blockquote");
      appendInlineMarkdown(document, element, quote[1]);
      root.appendChild(element);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  flushCode();
  return root;
}

function appendInlineMarkdown(document: Document, root: HTMLElement, text: string): void {
  const pattern = /(`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    appendText(document, root, text.slice(last, match.index));
    if (match[2]) appendTextElement(document, root, "code", match[2]);
    else if (match[3] && match[4]) {
      const link = document.createElement("a");
      link.textContent = match[3];
      link.setAttribute("href", match[4]);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      root.appendChild(link);
    } else if (match[5]) appendTextElement(document, root, "strong", match[5]);
    else if (match[6]) appendTextElement(document, root, "em", match[6]);
    last = match.index + match[0].length;
  }
  appendText(document, root, text.slice(last));
}

function appendText(document: Document, root: HTMLElement, value: string): void {
  if (value) appendTextElement(document, root, "span", value);
}

function appendTextElement(document: Document, root: HTMLElement, tag: string, value: string): void {
  const element = document.createElement(tag);
  element.textContent = value;
  root.appendChild(element);
}

function actionRow(
  document: Document,
  title: string,
  description: string,
): { row: HTMLElement; actions: HTMLElement } {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px;";
  const left = settingsMessageRow(document, title, description);
  left.style.padding = "0";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:8px;flex-shrink:0;";
  row.append(left, actions);
  return { row, actions };
}

function updateChannelSummary(config: ClaudePlusPlusConfigView): string {
  if (config.updateChannel === "custom") return `${config.updateRepo} ${config.updateRef || "(no ref set)"}`;
  if (config.updateChannel === "prerelease") return "Use stable and prerelease GitHub releases.";
  return "Use the latest stable GitHub release.";
}

function updateSummary(check: ClaudePlusPlusUpdateCheck | null): string {
  if (!check) return "No update check has run yet.";
  const latest = check.latestVersion ? `Latest v${check.latestVersion}. ` : "";
  return `${latest}Checked ${new Date(check.checkedAt).toLocaleString()}. ${check.error ?? ""}`.trim();
}

function selfUpdateSummary(state: SelfUpdateStateView | null): string {
  if (!state) return "No Claude++ update has run yet.";
  const when = new Date(state.completedAt ?? state.checkedAt).toLocaleString();
  if (state.status === "failed") return `Failed ${when}. ${state.error ?? "Unknown error"}`;
  if (state.status === "updated") return `Updated ${when}.`;
  if (state.status === "up-to-date") return `Up to date ${when}.`;
  if (state.status === "disabled") return `Skipped ${when}; automatic refresh is disabled.`;
  return "Checking for updates.";
}

function statusLabel(status: "ok" | "warn" | "error"): string {
  return status === "ok" ? "OK" : status === "warn" ? "Review" : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
