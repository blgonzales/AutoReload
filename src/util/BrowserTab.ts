import {
  Interval,
  TabStateType,
  convertIntervalToTimeoutInterval,
  getLogger,
} from '../common';

export default class BrowserTab {
  private tabId: number;
  private interval: Interval;
  private timer: ReturnType<typeof setInterval> | null;
  private enabled: boolean = false;

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

    this.timer = setInterval(() => this.reload(), timeout);
    this.enabled = true;

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
  }

  update(reloadData: TabStateType) {
    this.clearTimer();
    this.interval = reloadData.interval;

    if (reloadData.enabled) {
      this.createTimer();
    }
  }

  reload() {
    getLogger().debug(`Reloading tab ${this.tabId}`);
    browser.tabs.reload(this.tabId);
  }
}
