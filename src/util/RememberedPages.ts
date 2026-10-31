import { Interval, TabStateType, getLogger } from '../common';

export const STORAGE_KEY = 'rememberedPages';
export const MAX_ENTRIES = 200;

export type RememberedPage = {
  interval: Interval;
  enabled: true;
  savedAt: number;
};

export type RememberedPageStore = Record<string, RememberedPage>;

export type RememberedTab = {
  id?: number;
  url?: string;
  status?: string;
  discarded?: boolean;
};

export interface RememberedPagesDeps {
  // subset of browser.storage.local
  storage: {
    get: (key: string) => Promise<Record<string, any>>;
    set: (items: Record<string, any>) => Promise<void>;
  };
  // subset of browser.tabs
  tabs: {
    query: (queryInfo: Record<string, never>) => Promise<RememberedTab[]>;
    get: (tabId: number) => Promise<RememberedTab>;
  };
  // value of the "remember reload settings per page" setting
  isFeatureEnabled: () => Promise<boolean>;
  isTabEnabled: (tabId: number) => boolean;
  // tabs that must not be switched on by a page load, e.g. paused on purpose
  shouldSkipRestore?: (tabId: number) => boolean;
  enableTab: (tabId: number, interval: Interval) => Promise<void>;
  now?: () => number;
}

/**
 * Pages are keyed by their exact URL without the #fragment. Only http(s)
 * pages are remembered; anything else returns null.
 */
export const normalizeUrl = (url?: string): string | null => {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.href;
  } catch (e) {
    return null;
  }
};

/**
 * Optional per-page memory of reload settings, kept in storage.local.
 * Entries are only created by an explicit enable and removed on disable.
 */
export default class RememberedPages {
  private deps: RememberedPagesDeps;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: RememberedPagesDeps) {
    this.deps = deps;
  }

  // storage read-modify-write cycles are serialized so they cannot interleave
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<RememberedPageStore> {
    const stored = (await this.deps.storage.get(STORAGE_KEY))[STORAGE_KEY];
    return stored && typeof stored === 'object' ? { ...stored } : {};
  }

  private async persist(store: RememberedPageStore): Promise<void> {
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => store[a].savedAt - store[b].savedAt)
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((key) => delete store[key]);
    }
    await this.deps.storage.set({ [STORAGE_KEY]: store });
  }

  async count(): Promise<number> {
    return Object.keys(await this.load()).length;
  }

  async get(url: string): Promise<RememberedPage | null> {
    const key = normalizeUrl(url);
    return key ? ((await this.load())[key] ?? null) : null;
  }

  async remember(url: string, interval: Interval): Promise<void> {
    const key = normalizeUrl(url);
    if (!key) {
      return;
    }

    await this.serialize(async () => {
      const store = await this.load();
      delete store[key];
      store[key] = {
        interval,
        enabled: true,
        savedAt: (this.deps.now ?? Date.now)(),
      };
      await this.persist(store);
    });
  }

  async forget(url: string): Promise<void> {
    const key = normalizeUrl(url);
    if (!key) {
      return;
    }

    await this.serialize(async () => {
      const store = await this.load();
      if (key in store) {
        delete store[key];
        await this.persist(store);
      }
    });
  }

  async forgetAll(): Promise<void> {
    await this.serialize(() => this.persist({}));
  }

  /**
   * Called after the user enables, disables or changes the interval of a
   * tab. Does nothing unless the setting is on.
   */
  async onTabStateUpdated(tabId: number, state: TabStateType): Promise<void> {
    if (!(await this.deps.isFeatureEnabled())) {
      return;
    }

    const url = (await this.deps.tabs.get(tabId)).url;
    if (!url) {
      return;
    }

    if (state.enabled) {
      await this.remember(url, state.interval);
    } else {
      await this.forget(url);
    }
  }

  /**
   * Called when a tab finishes loading. Enables AutoReload with the saved
   * interval if the page is remembered and the tab is not already enabled.
   */
  async onTabComplete(tabId: number, url?: string): Promise<boolean> {
    if (!(await this.deps.isFeatureEnabled())) {
      return false;
    }

    const key = normalizeUrl(url);
    if (
      !key ||
      this.deps.isTabEnabled(tabId) ||
      this.deps.shouldSkipRestore?.(tabId)
    ) {
      return false;
    }

    const entry = (await this.load())[key];
    if (!entry) {
      return false;
    }

    getLogger().debug(`Restoring reload for tab ${tabId} on ${key}`);
    await this.deps.enableTab(tabId, entry.interval);
    return true;
  }

  /**
   * Covers tabs brought back by session restore before the listener ran.
   * Tabs that are still loading or discarded are skipped; they are picked up
   * by onTabComplete once they load, so a discarded tab is never woken up.
   */
  async restoreAll(): Promise<number> {
    if (!(await this.deps.isFeatureEnabled())) {
      return 0;
    }

    let restored = 0;
    for (const tab of await this.deps.tabs.query({})) {
      if (tab.id === undefined || tab.discarded || tab.status !== 'complete') {
        continue;
      }
      if (await this.onTabComplete(tab.id, tab.url)) {
        restored++;
      }
    }
    return restored;
  }
}
