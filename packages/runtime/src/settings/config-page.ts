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
  timer?: ConfigPageTimer;
}

export interface ConfigPageTimer {
  set(callback: () => void, delay: number): ConfigPageTimerHandle;
  clear(handle: ConfigPageTimerHandle): void;
}

export type ConfigPageTimerHandle = object;

interface ActiveConfigPageContext extends ConfigPageContext {
  refresh(): Promise<void>;
}

const CONFIG_UPDATE_REFRESH_MS = 500;
const defaultConfigPageTimer: ConfigPageTimer = {
  set: (callback, delay) => setTimeout(callback, delay) as ConfigPageTimerHandle,
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function renderConfigPage(context: ConfigPageContext): Promise<() => void> {
  let disposed = false;
  let generation = 0;
  let refreshHandle: ConfigPageTimerHandle | null = null;
  const timer = context.timer ?? defaultConfigPageTimer;
  let activeContext!: ActiveConfigPageContext;
  const cancelRefresh = (): void => {
    if (!refreshHandle) return;
    timer.clear(refreshHandle);
    refreshHandle = null;
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    cancelRefresh();
    const currentGeneration = ++generation;
    try {
      const [config, watcher] = await Promise.all([
        context.invoke<ClaudePlusPlusConfigView>("claudepp:get-config"),
        context.invoke<WatcherHealth>("claudepp:get-watcher-health"),
      ]);
      if (disposed || currentGeneration !== generation) return;
      renderConfig(activeContext, config, watcher);
      if (config.selfUpdate?.status === "checking" && context.root.isConnected) {
        refreshHandle = timer.set(() => {
          refreshHandle = null;
          if (!disposed && context.root.isConnected) void refresh();
        }, CONFIG_UPDATE_REFRESH_MS);
      }
    } catch (error) {
      if (!disposed && currentGeneration === generation) renderLoadError(context.root, error);
    }
  };
  activeContext = { ...context, refresh };
  renderLoading(context.root);
  await refresh();
  return () => {
    disposed = true;
    generation += 1;
    cancelRefresh();
  };
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
  context: ActiveConfigPageContext,
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
  context: ActiveConfigPageContext,
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
    await context.refresh();
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
  card.appendChild(selfUpdateRow(document, config.selfUpdate));
  card.appendChild(updateActionsRow(context, config, card));
  if (config.updateCheck) card.appendChild(releaseNotesRow(document, config.updateCheck));
  section.appendChild(card);
  return section;
}

function updateChannelRow(context: ActiveConfigPageContext, config: ClaudePlusPlusConfigView): HTMLElement {
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
      .then(() => context.refresh());
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
      await context.refresh();
    }));
  }
  return action.row;
}

function updateActionsRow(
  context: ActiveConfigPageContext,
  config: ClaudePlusPlusConfigView,
  card: HTMLElement,
): HTMLElement {
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
    await context.refresh();
  }));
  if (check?.releaseUrl) {
    action.actions.appendChild(settingsButton(document, "Release Notes", async () => {
      await context.invoke("claudepp:open-external", check.releaseUrl);
    }));
  }
  const downloadLabel = "Download Update";
  const updateInProgress = config.selfUpdate?.status === "checking";
  const download = settingsButton(
    document,
    updateInProgress ? selfUpdateActionLabel(config.selfUpdate) : downloadLabel,
    async () => {
      if (download.disabled) return;
      download.disabled = true;
      download.textContent = "Starting Update…";
      card.querySelector('[data-claudepp-update-error="true"]')?.remove();
      try {
        await context.invoke("claudepp:run-claudepp-update");
        await context.refresh();
      } catch (error) {
        download.disabled = false;
        download.textContent = downloadLabel;
        const message = settingsMessageRow(
          document,
          "Could not start Claude++ update",
          errorMessage(error),
        );
        message.setAttribute("data-claudepp-update-error", "true");
        message.setAttribute("role", "alert");
        card.appendChild(message);
      }
    },
  );
  download.disabled = updateInProgress;
  action.actions.appendChild(download);
  return action.row;
}

function renderWatcherSection(context: ActiveConfigPageContext, health: WatcherHealth): HTMLElement {
  const document = context.root.ownerDocument;
  const section = settingsSection(document, "Auto-Repair Watcher");
  const card = settingsCard(document);
  const action = actionRow(document, health.title, health.summary);
  action.actions.appendChild(settingsButton(document, "Check Now", async () => {
    await context.refresh();
  }));
  action.actions.appendChild(settingsButton(
    document,
    health.installed ? "Disable Watcher" : "Enable Watcher",
    async () => {
      await context.invoke("claudepp:set-watcher-enabled", !health.installed);
      await context.refresh();
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
  return selfUpdateProgressSummary(state);
}

function selfUpdateRow(document: Document, state: SelfUpdateStateView | null): HTMLElement {
  const row = settingsMessageRow(document, "Last Claude++ update", selfUpdateSummary(state));
  const progress = knownDownloadProgress(state);
  if (!progress) return row;
  const element = document.createElement("progress");
  element.setAttribute("data-claudepp-update-progress", "true");
  element.setAttribute("value", String(progress.downloadedBytes));
  element.setAttribute("max", String(progress.totalBytes));
  element.setAttribute("aria-label", `Claude++ update download ${progress.percent}%`);
  element.textContent = `${progress.percent}%`;
  element.style.cssText = "width:100%;margin-top:8px;";
  row.appendChild(element);
  return row;
}

function selfUpdateProgressSummary(state: SelfUpdateStateView): string {
  if (state.phase === "downloading") {
    const downloadedBytes = validByteCount(state.downloadedBytes) ? state.downloadedBytes : 0;
    const progress = knownDownloadProgress(state);
    if (progress) {
      return `Downloading ${progress.percent}% · ${formatBytes(progress.downloadedBytes)} of ` +
        `${formatBytes(progress.totalBytes)}.`;
    }
    return `Downloading update · ${formatBytes(downloadedBytes)} downloaded.`;
  }
  if (state.phase === "verifying") return "Verifying update.";
  if (state.phase === "extracting") return "Extracting update.";
  if (state.phase === "building") return "Building and testing Custom update.";
  if (state.phase === "installing") return "Installing update.";
  return "Checking for updates.";
}

function selfUpdateActionLabel(state: SelfUpdateStateView | null): string {
  if (state?.phase === "downloading") {
    const progress = knownDownloadProgress(state);
    return progress ? `Downloading ${progress.percent}%` : "Downloading Update…";
  }
  if (state?.phase === "verifying") return "Verifying Update…";
  if (state?.phase === "extracting") return "Extracting Update…";
  if (state?.phase === "building") return "Building Update…";
  if (state?.phase === "installing") return "Installing Update…";
  return "Update in Progress";
}

function knownDownloadProgress(state: SelfUpdateStateView | null): {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
} | null {
  if (state?.phase !== "downloading" || !validByteCount(state.downloadedBytes) ||
    !validByteCount(state.totalBytes) || state.totalBytes <= 0) return null;
  const downloadedBytes = Math.min(state.downloadedBytes, state.totalBytes);
  return {
    downloadedBytes,
    totalBytes: state.totalBytes,
    percent: Math.floor(downloadedBytes * 100 / state.totalBytes),
  };
}

function validByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  const rounded = amount >= 10 || Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1);
  return `${rounded} ${unit}`;
}

function statusLabel(status: "ok" | "warn" | "error"): string {
  return status === "ok" ? "OK" : status === "warn" ? "Review" : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
