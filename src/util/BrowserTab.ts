import {
  Interval,
  TabStateType,
  convertIntervalToTimeoutInterval,
  getLogger,
  sleep,
} from '../common';
import { ActivityRecorder, activityLog, formatInterval } from './ActivityLog';

export type BrowserTabDeps = {
  log: ActivityRecorder;
  now: () => number;
  reloadTab: (tabId: number) => Promise<unknown>;
  setIcon: (tabId: number, image: string) => void;
  sleep: (ms: number) => Promise<unknown>;
};

const defaultDeps = (): BrowserTabDeps => ({
  log: activityLog,
  now: Date.now,
  reloadTab: (tabId) => browser.tabs.reload(tabId),
  setIcon: (tabId, image) =>
    browser.browserAction.setIcon({ path: image, tabId }),
  sleep,
});

export default class BrowserTab {
  private tabId: number;
  private interval: Interval;
  private timer: ReturnType<typeof setInterval> | null;
  private enabled: boolean = false;
  private nextReloadAt: number | null = null;
  private deps: BrowserTabDeps;

  constructor(
    tabId: number,
    interval: Interval,
    enabled: boolean,
    deps: Partial<BrowserTabDeps> = {}
  ) {
    this.tabId = tabId;
    this.interval = interval;
    this.timer = null;
    this.deps = { ...defaultDeps(), ...deps };

    if (enabled) {
      this.createTimer('enabled by the "Default enabled" setting');
    }
  }

  getTabId() {
    return this.tabId;
  }

  createTimer(reason: string = 'enabled') {
    if (this.timer !== null) {
      throw new Error(
        `Timer ${this.timer} for tabId ${this.tabId} already exists`
      );
    }

    const timeout = convertIntervalToTimeoutInterval(this.interval);

    this.timer = setInterval(async () => await this.reload(), timeout);
    this.enabled = true;
    this.nextReloadAt = this.deps.now() + timeout;
    this.deps.log.record(
      'timer-started',
      `Timer started: reload every ${formatInterval(this.interval)} (${reason})`,
      { tabId: this.tabId }
    );

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

  getNextReloadAt() {
    return this.timer === null ? null : this.nextReloadAt;
  }

  clearTimer(reason: string = 'disabled') {
    const wasRunning = this.timer !== null;
    if (this.timer !== null) {
      getLogger().debug(`Clearing timer ${this.timer} for tab ${this.tabId}`);
      clearInterval(this.timer);

      this.timer = null;
    }

    this.enabled = false;
    this.nextReloadAt = null;

    if (wasRunning) {
      this.deps.log.record('timer-stopped', `Timer stopped (${reason})`, {
        tabId: this.tabId,
      });
    }
  }

  update(reloadData: TabStateType) {
    const wasRunning = this.timer !== null;
    const oldInterval = this.interval;
    const intervalChanged =
      convertIntervalToTimeoutInterval(oldInterval) !==
      convertIntervalToTimeoutInterval(reloadData.interval);

    this.interval = reloadData.interval;

    if (wasRunning && reloadData.enabled) {
      // restart with the new interval; log it as one event, not stop + start
      this.stopQuietly();
      this.createTimer(
        intervalChanged
          ? `restarted: interval changed from ${formatInterval(oldInterval)}`
          : 'restarted from the popup'
      );
      return;
    }

    if (wasRunning) {
      this.clearTimer('turned off in the popup');
    } else if (reloadData.enabled) {
      this.createTimer('turned on in the popup');
    }
  }

  private stopQuietly() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.enabled = false;
    this.nextReloadAt = null;
  }

  setAddonIcon(image: string) {
    this.deps.setIcon(this.tabId, image);
  }

  async reload(trigger: 'scheduled' | 'manual' = 'scheduled') {
    getLogger().debug(`Reloading tab ${this.tabId}`);
    if (trigger === 'scheduled') {
      this.nextReloadAt = this.deps.now() + convertIntervalToTimeoutInterval(this.interval);
    }
    this.setAddonIcon('icons/loading.gif');

    try {
      await this.deps.reloadTab(this.tabId);
      this.deps.log.record(
        'reload',
        trigger === 'scheduled'
          ? `Reloaded (scheduled, every ${formatInterval(this.interval)})`
          : 'Reloaded (manual)',
        { tabId: this.tabId }
      );
    } catch (e) {
      getLogger().error(`Failed to reload tab ${this.tabId}`, e);
      this.deps.log.record('error', `Reload failed: ${String(e)}`, {
        tabId: this.tabId,
      });
    }

    await this.deps.sleep(5000);
    this.setAddonIcon('icons/48.png');
  }
}
