import BrowserTab from './BrowserTab';
import { AppStateType, SettingsType, getLogger } from '../common';

export default class ReloadManager {
  private browserTabs;
  private idleTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    this.browserTabs = new Map<number, BrowserTab>();
    this.idleTimer = null;
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
  }

  enable() {
    for (const [, browserTab] of this.browserTabs) {
      if (!browserTab.isEnabled()) {
        browserTab.createTimer();
      }
    }
  }

  disable() {
    for (const [, browserTab] of this.browserTabs) {
      browserTab.clearTimer();
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
        this.enable();
      } else {
        getLogger().debug('Disabling all registered auto reload tabs');
        this.disable();
      }
    }
  }

  createIdleTimer(timeout: number) {
    getLogger().debug(`Creating idle timer for ${timeout / 1000} seconds`);

    this.idleTimer = setTimeout(() => {
      getLogger().debug(
        `Disabling all tab reload timers due to being idle after ${
          timeout / 1000
        } seconds`
      );

      this.cancelIdleTimer();
      this.disable();
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
