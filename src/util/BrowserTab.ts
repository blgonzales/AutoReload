import {
  Interval,
  TabStateType,
  convertIntervalToTimeoutInterval,
  getLogger,
  sleep,
} from '../common';

export default class BrowserTab {
  private tabId: number;
  private interval: Interval;
  private timer: ReturnType<typeof setInterval> | null;
  private enabled: boolean = false;
  private nextReloadAt: number | null = null;
  private pausedByIdle = false;
  private pausedSince: number | null = null;

  constructor(tabId: number, interval: Interval, enabled: boolean) {
    this.tabId = tabId;
    this.interval = interval;
    this.timer = null;

    if (enabled) {
      this.createTimer();
    }
  }

  getTabId() {
    return this.tabId;
  }

  createTimer() {
    if (this.timer !== null) {
      throw new Error(
        `Timer ${this.timer} for tabId ${this.tabId} already exists`
      );
    }

    const timeout = convertIntervalToTimeoutInterval(this.interval);

    this.timer = setInterval(async () => {
      this.nextReloadAt = Date.now() + timeout;
      await this.reload();
    }, timeout);
    this.nextReloadAt = Date.now() + timeout;
    this.enabled = true;
    this.pausedByIdle = false;
    this.pausedSince = null;

    getLogger().debug(
      `Created timer ${this.timer} for tabId ${this.tabId} with ${
        timeout / 1000
      } second reload`
    );
  }

  isEnabled() {
    return this.enabled;
  }

  getInterval() {
    return this.interval;
  }

  clearTimer() {
    if (this.timer !== null) {
      getLogger().debug(`Clearing timer ${this.timer} for tab ${this.tabId}`);
      clearInterval(this.timer);

      this.timer = null;
    }

    this.enabled = false;
    this.nextReloadAt = null;
  }

  getNextReloadAt() {
    return this.nextReloadAt;
  }

  isPausedByIdle() {
    return this.pausedByIdle;
  }

  // call after clearTimer(): the tab was switched off because the user is away
  markPausedByIdle(since: number = Date.now()) {
    this.pausedByIdle = !this.enabled;
    this.pausedSince = this.pausedByIdle ? since : null;
  }

  getPausedSince() {
    return this.pausedSince;
  }

  clearPausedByIdle() {
    this.pausedByIdle = false;
    this.pausedSince = null;
  }

  getIntervalMs() {
    return convertIntervalToTimeoutInterval(this.interval);
  }

  setBadge(text: string, color?: string) {
    browser.browserAction.setBadgeText({ text, tabId: this.tabId });
    if (text && color) {
      browser.browserAction.setBadgeBackgroundColor({
        color,
        tabId: this.tabId,
      });
    }
  }

  // tooltip of the toolbar button for this tab; null restores the default
  setTitle(title: string | null) {
    browser.browserAction.setTitle({ title, tabId: this.tabId });
  }

  update(reloadData: TabStateType) {
    this.clearTimer();
    this.clearPausedByIdle();
    this.interval = reloadData.interval;

    if (reloadData.enabled) {
      this.createTimer();
    }
  }

  setAddonIcon(image: string) {
    browser.browserAction.setIcon({
      path: image,
      tabId: this.tabId,
    });
  }

  async reload() {
    getLogger().debug(`Reloading tab ${this.tabId}`);
    this.setAddonIcon('icons/loading.gif');

    await browser.tabs.reload(this.tabId);

    await sleep(5000);
    this.setAddonIcon('icons/48.png');
  }
}
