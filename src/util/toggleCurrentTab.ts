import { Interval, TabStateType, SettingsType, getLogger } from '../common';

// the subset of BrowserTab used for toggling, so it can be faked in tests
export interface ToggleableTab {
  isEnabled(): boolean;
  getInterval(): Interval;
}

export interface ToggleCurrentTabDeps {
  getSettings: () => Promise<SettingsType>;
  // returns the active tab, creating it with the default settings if absent
  getOrCreateBrowserTab: (
    settings: SettingsType
  ) => Promise<ToggleableTab | null | undefined>;
  // applies the new state through the same path as the popup's header switch
  // (the background's updateTabState handler), so anything hooked into that
  // path also runs for the shortcut
  applyTabState: (state: TabStateType) => Promise<void>;
}

// Toggles AutoReload for the active tab exactly like the popup header switch:
// the tab keeps its interval and only its enabled state is flipped.
// Returns the new enabled state, or null when there is no active tab.
export const toggleCurrentTab = async (
  deps: ToggleCurrentTabDeps
): Promise<boolean | null> => {
  const tab = await deps.getOrCreateBrowserTab(await deps.getSettings());
  if (!tab) {
    getLogger().error('Current tab could not be found for toggle command');
    return null;
  }

  const enabled = !tab.isEnabled();
  await deps.applyTabState({ enabled, interval: tab.getInterval() });
  return enabled;
};
