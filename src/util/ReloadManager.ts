import BrowserTab from './BrowserTab';
import { AppStateType, Interval, SettingsType, getLogger } from '../common';
import CountdownTicker, {
  BADGE_TEXT_COLOR,
  TabIndicatorState,
  describeTab,
} from './Countdown';

// where tabs paused by the idle timeout are remembered (browser.storage.local)
export type PauseStore = {
  get: (key: string) => Promise<Record<string, any>>;
  set: (items: Record<string, any>) => Promise<void>;
};
export const PAUSED_STORAGE_KEY = 'idlePausedTabs';
export type PausedRecord = { interval: Interval; since: number };

export default class ReloadManager {
  private browserTabs;
  private idleTimer: ReturnType<typeof setInterval> | null;
  private showCountdown = false;
  private countdownTicker: CountdownTicker;
  private isRetrying: (tabId: number) => boolean = () => false;
  private pauseStore?: PauseStore;
  private persistedPaused = '';
  private lastIdleTimeout = 0;

  constructor() {
    this.browserTabs = new Map<number, BrowserTab>();
    this.idleTimer = null;
    this.countdownTicker = new CountdownTicker({
      onTick: () => this.updateBadges(),
      onStop: () => this.clearBadges(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle),
    });
  }

  setShowCountdown(show: boolean) {
    this.showCountdown = show;
    this.syncCountdown();
    if (!show) {
      this.clearBadges();
    }
  }

  setPauseStore(store: PauseStore) {
    this.pauseStore = store;
  }

  // paused-by-idle tabs, saved so a restart of the background page during the
  // pause does not forget which tabs to resume (tab ids survive that, not a
  // full browser restart; remembered pages cover that case)
  private persistPaused() {
    if (!this.pauseStore) {
      return;
    }
    const record: Record<number, PausedRecord> = {};
    for (const [id, tab] of this.browserTabs) {
      const since = tab.getPausedSince();
      if (tab.isPausedByIdle() && since !== null) {
        record[id] = { interval: tab.getInterval(), since };
      }
    }
    const json = JSON.stringify(record);
    if (json === this.persistedPaused) {
      return;
    }
    this.persistedPaused = json;
    this.pauseStore
      .set({ [PAUSED_STORAGE_KEY]: record })
      .catch((e) => getLogger().error('Failed to save paused tabs', e));
  }

  // register tabs that were paused before the background page restarted
  restorePaused(
    saved: Record<string, PausedRecord> | undefined,
    liveTabIds: number[]
  ) {
    for (const [key, entry] of Object.entries(saved ?? {})) {
      const tabId = Number(key);
      if (!liveTabIds.includes(tabId) || this.browserTabs.has(tabId)) {
        continue;
      }
      const tab = this.registerStoppedTab(tabId, entry.interval);
      tab.markPausedByIdle(entry.since);
    }
    this.persistedPaused = JSON.stringify(saved ?? {});
    this.syncCountdown();
  }

  protected registerStoppedTab(tabId: number, interval: Interval) {
    const tab = new BrowserTab(tabId, interval, false);
    this.browserTabs.set(tabId, tab);
    return tab;
  }

  getIdleTimeout() {
    return this.lastIdleTimeout;
  }

  // the user is back: restart the tabs the idle pause switched off (and only
  // those; tabs switched off by hand are not paused tabs)
  resumeFromIdle() {
    const paused = [...this.browserTabs.values()].filter((t) =>
      t.isPausedByIdle()
    );
    for (const tab of paused) {
      getLogger().debug(`Resuming tab ${tab.getTabId()} after idle pause`);
      tab.update({ enabled: true, interval: tab.getInterval() });
    }
    this.syncCountdown();
    return paused.length;
  }

  // lets another component report tabs that are waiting to retry after an error
  setRetryProbe(isRetrying: (tabId: number) => boolean) {
    this.isRetrying = isRetrying;
  }

  // start/stop the shared badge ticker to match settings and the tabs that
  // show something: enabled tabs and tabs paused because the user is away
  syncCountdown() {
    let paused = 0;
    for (const [, browserTab] of this.browserTabs) {
      paused += browserTab.isPausedByIdle() ? 1 : 0;
    }
    this.countdownTicker.sync(
      this.showCountdown,
      this.getNumberOfEnabledTabs() + paused
    );
    this.persistPaused();
  }

  private getIndicatorState(
    browserTab: BrowserTab,
    now: number
  ): TabIndicatorState {
    // a pending retry after an HTTP error wins over everything else: it keeps
    // going while the user is away, so the badge must say so
    if (this.isRetrying(browserTab.getTabId())) {
      return { kind: 'retrying' };
    }
    if (browserTab.isPausedByIdle()) {
      return { kind: 'paused' };
    }
    if (!browserTab.isEnabled()) {
      return { kind: 'off' };
    }
    const next = browserTab.getNextReloadAt();
    return {
      kind: 'running',
      intervalMs: browserTab.getIntervalMs(),
      remainingMs: next === null ? null : next - now,
    };
  }

  private updateBadges() {
    browser.browserAction.setBadgeTextColor?.({ color: BADGE_TEXT_COLOR });
    const now = Date.now();
    for (const [, browserTab] of this.browserTabs) {
      const indicator = describeTab(this.getIndicatorState(browserTab, now));
      browserTab.setBadge(indicator.badge, indicator.color);
      browserTab.setTitle(indicator.title);
    }
  }

  private clearBadges() {
    for (const [, browserTab] of this.browserTabs) {
      browserTab.setBadge('');
      browserTab.setTitle(
        this.showCountdown
          ? describeTab({ kind: 'off', allTabsOff: this.browserTabs.size > 1 })
              .title
          : null
      );
    }
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
        settings.defaultEnabled
      );
      this.browserTabs.set(tabId, currentTab);
      this.syncCountdown();
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
    browserTab.clearTimer();

    this.browserTabs.delete(browserTab.getTabId());
    this.syncCountdown();
  }

  enable() {
    for (const [, browserTab] of this.browserTabs) {
      if (!browserTab.isEnabled()) {
        browserTab.createTimer();
      }
    }
    this.syncCountdown();
  }

  disable() {
    for (const [, browserTab] of this.browserTabs) {
      browserTab.clearTimer();
      browserTab.clearPausedByIdle();
    }
    this.clearBadges();
    this.syncCountdown();
  }

  remove() {
    this.disable();
    this.browserTabs = new Map();
  }

  update(data: AppStateType) {
    if (data.enabled !== this.isEnabled()) {
      if (data.enabled) {
        getLogger().debug('Enabling all registered auto reload tabs');
        this.enable();
      } else {
        getLogger().debug('Disabling all registered auto reload tabs');
        this.disable();
      }
    }
  }

  // idle timeout: switch every running tab off, but keep showing that they
  // were paused (badge + tooltip) instead of looking like they never ran
  pauseForIdle() {
    const running = [...this.browserTabs.values()].filter((t) => t.isEnabled());
    const since = Date.now();
    running.forEach((t) => {
      t.clearTimer();
      t.markPausedByIdle(since);
    });
    this.syncCountdown();
  }

  createIdleTimer(timeout: number) {
    getLogger().debug(`Creating idle timer for ${timeout / 1000} seconds`);
    this.lastIdleTimeout = timeout;

    this.idleTimer = setTimeout(() => {
      getLogger().debug(
        `Disabling all tab reload timers due to being idle after ${
          timeout / 1000
        } seconds`
      );

      this.cancelIdleTimer();
      this.pauseForIdle();
    }, timeout);
  }

  cancelIdleTimer() {
    if (this.idleTimer === null) {
      return;
    }

    getLogger().debug(`Canceling idle timer`);

    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
