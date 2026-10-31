import { getLogger } from '../common';

export type SmartTimingOptions = {
  // skip a scheduled reload while the tab is still loading
  skipWhileLoading: boolean;
  // restart the countdown when the tab starts loading for another reason
  restartOnManualLoad: boolean;
};

export type SmartTimingDeps = {
  getOptions: () => Promise<SmartTimingOptions>;
  getTabStatus: (tabId: number) => Promise<string | undefined>;
  restartTimer: (tabId: number) => void;
  now?: () => number;
};

// how long a reload started by AutoReload may take to report 'loading'
// before the expectation is considered stale
export const OWN_RELOAD_WINDOW_MS = 5000;

/**
 * Decides when a scheduled reload should be skipped and when a tab's
 * countdown should restart. Browser calls are injected so the logic can be
 * unit tested.
 *
 * Own reloads are told apart from user navigations with a per-tab flag:
 * it is set right before AutoReload calls tabs.reload() and consumed by the
 * first 'loading' event of that tab. Any later 'loading' event therefore
 * belongs to something else (the user, a link, a script). The flag expires
 * after OWN_RELOAD_WINDOW_MS so a reload that never produced a 'loading'
 * event cannot swallow a later manual one.
 */
export default class SmartTiming {
  private deps: SmartTimingDeps;
  private expectingOwnReload = new Map<number, number>();

  constructor(deps: SmartTimingDeps) {
    this.deps = deps;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  async shouldReload(tabId: number): Promise<boolean> {
    const options = await this.deps.getOptions();
    if (!options.skipWhileLoading) {
      return true;
    }

    const status = await this.deps.getTabStatus(tabId);
    if (status === 'loading') {
      getLogger().debug(`Tab ${tabId} is still loading, skipping reload`);
      return false;
    }

    return true;
  }

  // call right before browser.tabs.reload()
  markOwnReload(tabId: number) {
    this.expectingOwnReload.set(tabId, this.now() + OWN_RELOAD_WINDOW_MS);
  }

  // call if browser.tabs.reload() failed
  cancelOwnReload(tabId: number) {
    this.expectingOwnReload.delete(tabId);
  }

  // call for tabs.onUpdated with changeInfo.status === 'loading'
  async onTabLoading(tabId: number) {
    const expiresAt = this.expectingOwnReload.get(tabId);
    this.expectingOwnReload.delete(tabId);

    if (expiresAt !== undefined && expiresAt >= this.now()) {
      return;
    }

    const options = await this.deps.getOptions();
    if (options.restartOnManualLoad) {
      getLogger().debug(`Tab ${tabId} loaded by user, restarting countdown`);
      this.deps.restartTimer(tabId);
    }
  }

  forget(tabId: number) {
    this.expectingOwnReload.delete(tabId);
  }
}
