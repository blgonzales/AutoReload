import {
  Interval,
  TabStateType,
  convertIntervalToTimeoutInterval,
  getLogger,
  sleep,
} from '../common';
import SmartTiming from './SmartTiming';

export default class BrowserTab {
  private tabId: number;
  private interval: Interval;
  private timer: ReturnType<typeof setInterval> | null;
  private enabled: boolean = false;
  private smartTiming?: SmartTiming;

  constructor(
    tabId: number,
    interval: Interval,
    enabled: boolean,
    smartTiming?: SmartTiming
  ) {
    this.tabId = tabId;
    this.smartTiming = smartTiming;
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

    this.timer = setInterval(async () => await this.reload(), timeout);
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

  // start the countdown over, e.g. after the user reloaded the tab
  restartTimer() {
    if (!this.enabled) {
      return;
    }

    this.clearTimer();
    this.createTimer();
  }

  update(reloadData: TabStateType) {
    this.clearTimer();
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
    if (
      this.smartTiming &&
      !(await this.smartTiming.shouldReload(this.tabId))
    ) {
      return;
    }

    getLogger().debug(`Reloading tab ${this.tabId}`);
    this.setAddonIcon("icons/loading.gif");

    this.smartTiming?.markOwnReload(this.tabId);
    try {
      await browser.tabs.reload(this.tabId);
    } catch (error) {
      this.smartTiming?.cancelOwnReload(this.tabId);
      throw error;
    }

    await sleep(5000);
    this.setAddonIcon("icons/48.png")
  }
}
