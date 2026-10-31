import BrowserTab, { BrowserTabDeps } from './BrowserTab';
import { AppStateType, SettingsType, getLogger } from '../common';
import { ActivityRecorder, IdleStatus, activityLog, formatMs } from './ActivityLog';

export type ReloadManagerDeps = {
  log: ActivityRecorder;
  now: () => number;
  tabDeps: Partial<BrowserTabDeps>;
};

export default class ReloadManager {
  private browserTabs;
  private idleTimer: ReturnType<typeof setInterval> | null;
  private idleDueAt: number | null = null;
  private pausedByIdle = false;
  private deps: ReloadManagerDeps;

  constructor(deps: Partial<ReloadManagerDeps> = {}) {
    this.browserTabs = new Map<number, BrowserTab>();
    this.idleTimer = null;
    this.deps = { log: activityLog, now: Date.now, tabDeps: {}, ...deps };
  }

  /** The user changed something by hand, so "paused by idle" no longer applies. */
  clearIdlePause() {
    this.pausedByIdle = false;
  }

  getBrowserTabs(): BrowserTab[] {
    return Array.from(this.browserTabs.values());
  }

  getIdleStatus(): IdleStatus {
    if (this.idleTimer !== null) {
      return { state: 'idle-pending', pausesAt: this.idleDueAt };
    }
    if (this.pausedByIdle && this.getNumberOfEnabledTabs() === 0) {
      return { state: 'paused-by-idle' };
    }
    return { state: 'active' };
  }

  getNumberOfTabs() {
    return this.browserTabs.size;
  }

  getNumberOfEnabledTabs() {
    let numEnabled = 0;

    for (const [, browserTab] of this.browserTabs) {
      numEnabled += browserTab.isEnabled() ? 1 : 0;
    }

    return numEnabled;
  }

  isEnabled() {
    return this.getNumberOfEnabledTabs() === this.getNumberOfTabs();
  }

  async getCurrentTabId(): Promise<number | null> {
    const tabs = await browser.tabs.query({
      currentWindow: true,
      active: true,
    });

    if (!tabs) {
      console.error('Failed to query for current browser tab');
      return null;
    }

    return Number(tabs[0].id);
  }

  async getOrCreateBrowserTab(settings: SettingsType) {
    const tabId = await this.getCurrentTabId();
    if (!tabId) {
      return null;
    }

    let currentTab = null;
    if (this.browserTabs.has(tabId)) {
      currentTab = this.browserTabs.get(tabId);
    } else {
      currentTab = new BrowserTab(
        tabId,
        settings.defaultInterval,
        settings.defaultEnabled,
        { log: this.deps.log, now: this.deps.now, ...this.deps.tabDeps }
      );
      this.browserTabs.set(tabId, currentTab);
    }

    return currentTab;
  }

  getBrowserTab(tabId: number) {
    if (!this.browserTabs.has(tabId)) {
      return null;
    }

    return this.browserTabs.get(tabId);
  }

  deleteBrowserTab(browserTab: BrowserTab) {
    browserTab.clearTimer('tab closed');

    this.browserTabs.delete(browserTab.getTabId());
  }

  enable(reason: string = 'global switch turned on') {
    for (const [, browserTab] of this.browserTabs) {
      if (!browserTab.isEnabled()) {
        browserTab.createTimer(reason);
      }
    }
  }

  disable(reason: string = 'global switch turned off') {
    for (const [, browserTab] of this.browserTabs) {
      browserTab.clearTimer(reason);
    }
  }

  remove() {
    this.disable();
    this.browserTabs = new Map();
  }

  update(data: AppStateType) {
    if (data.enabled !== this.isEnabled()) {
      if (data.enabled) {
        getLogger().debug('Enabling all registered auto reload tabs');
        this.pausedByIdle = false;
        this.deps.log.record(
          'global',
          `Global switch turned on for ${this.getNumberOfTabs()} registered tab(s)`
        );
        this.enable();
      } else {
        getLogger().debug('Disabling all registered auto reload tabs');
        this.deps.log.record(
          'global',
          `Global switch turned off for ${this.getNumberOfTabs()} registered tab(s)`
        );
        this.disable();
      }
    }
  }

  createIdleTimer(timeout: number) {
    getLogger().debug(`Creating idle timer for ${timeout / 1000} seconds`);

    this.idleDueAt = this.deps.now() + timeout;
    this.deps.log.record(
      'idle',
      `Browser is idle: reloading pauses in ${formatMs(timeout)} unless you come back`
    );

    this.idleTimer = setTimeout(() => {
      getLogger().debug(
        `Disabling all tab reload timers due to being idle after ${
          timeout / 1000
        } seconds`
      );

      this.clearIdleTimer();
      this.pausedByIdle = true;
      this.deps.log.record(
        'idle',
        `Idle for ${formatMs(timeout)}: pausing ${this.getNumberOfEnabledTabs()} running tab(s)`
      );
      this.disable('paused: browser idle timeout reached');
    }, timeout);
  }

  private clearIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = null;
    this.idleDueAt = null;
  }

  /** Called when the user is active again. Returns true if a timer was pending. */
  cancelIdleTimer(): boolean {
    if (this.idleTimer === null) {
      return false;
    }

    getLogger().debug(`Canceling idle timer`);

    this.clearIdleTimer();
    return true;
  }
}
