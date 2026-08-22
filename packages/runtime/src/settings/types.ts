import type {
  SettingsPage,
  SettingsSection,
  TweakManifest,
} from "@claude-plusplus/sdk";
import type { ClaudePlusPlusUpdateCheck } from "../config.js";
import type { ListedTweak } from "../tweak-catalog.js";

export type BuiltInSettingsRoute =
  | "claudepp:config"
  | "claudepp:tweaks"
  | "claudepp:store";

export type ListedTweakView = ListedTweak;

export interface RegisteredSettingsSection {
  id: string;
  tweakId: string;
  section: SettingsSection;
}

export interface RegisteredSettingsPage {
  id: string;
  tweakId: string;
  manifest: TweakManifest;
  page: SettingsPage;
}

export interface SettingsProductPageContext {
  root: HTMLElement;
  listedTweaks: readonly ListedTweakView[];
  sections: readonly RegisteredSettingsSection[];
  pages: readonly RegisteredSettingsPage[];
  activate(id: string): void;
  setStoreUpdateCount(count: number): void;
  setProductUpdateCheck(check: ClaudePlusPlusUpdateCheck | null): void;
}

export type SettingsProductPageRenderer = (
  context: SettingsProductPageContext,
) => void | (() => void);

export interface SettingsProductServices {
  renderConfig: SettingsProductPageRenderer;
  renderTweaks: SettingsProductPageRenderer;
  renderStore: SettingsProductPageRenderer;
  openExternal(url: string): Promise<unknown>;
}
