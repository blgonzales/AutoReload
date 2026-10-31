import {
  Interval,
  TabStateType,
  convertIntervalToTimeoutInterval,
  getLogger,
  sleep,
} from '../common';
import { RandomizeOptions, computeDelay } from './randomDelay';

export default class BrowserTab {
  private tabId: number;
  private interval: Interval;
  private timer: ReturnType<typeof setTimeout> | null;
  private enabled: boolean = false;
  private generation: number = 0;
  private getRandomize: () => Promise<RandomizeOptions>;
  private rng: () => number;

  constructor(
    tabId: number,
    interval: Interval,
    enabled: boolean,
    getRandomize: () => Promise<RandomizeOptions> = async () => ({
      randomizeInterval: false,
      randomizeSpread: 0,
    }),
    rng: () => number = Math.random
  ) {
    this.tabId = tabId;
    this.interval = interval;
    this.timer = null;
    this.getRandomize = getRandomize;
    this.rng = rng;

    if (enabled) {
      this.createTimer();
    }
  }

  getTabId() {
    return this.tabId;
  }

  createTimer() {
    if (this.enabled) {
      throw new Error(`Timer for tabId ${this.tabId} already exists`);
    }

    this.enabled = true;
    this.scheduleNext(++this.generation);
  }

  // Each reload is scheduled separately, so the randomize setting is read
  // (and a new random delay drawn) before every reload.
  private async scheduleNext(generation: number) {
    const base = convertIntervalToTimeoutInterval(this.interval);
    let delay = base;

    try {
      delay = computeDelay(base, await this.getRandomize(), this.rng);
    } catch (error) {
      getLogger().error('Failed to read randomize setting', error);
    }

    // timer was cleared or recreated while settings were being read
    if (generation !== this.generation) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleNext(generation);
      this.reload();
    }, delay);

    getLogger().debug(
      `Created timer ${this.timer} for tabId ${this.tabId} with ${
        delay / 1000
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
      clearTimeout(this.timer);

      this.timer = null;
    }

    this.generation++;
    this.enabled = false;
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
    getLogger().debug(`Reloading tab ${this.tabId}`);
    this.setAddonIcon("icons/loading.gif");

    await browser.tabs.reload(this.tabId);

    await sleep(5000);
    this.setAddonIcon("icons/48.png")
  }
}
