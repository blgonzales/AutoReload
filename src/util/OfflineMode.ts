import {
  OfflineMode as Mode,
  WORKER_QUERY_PARAM,
  OFFLINE_CACHE_NAME,
  STATUS_KEY_PATH,
  FALLBACK_STATUSES,
  buildWorkerScript,
  isOfflineMode,
} from './OfflineWorker';

export type { OfflineMode } from './OfflineWorker';

export type OfflineModeSetting = Mode | 'off';

export type OfflinePrefs = {
  mode: Mode | 'off';
  // random per-site value that must accompany requests for the worker script
  token: string;
  // 'off' entries stay until the worker has been removed from the site
  cleanup?: boolean;
};

const KEY_PREFIX = 'offline:';

export type StorageArea = {
  get: () => Promise<Record<string, any>>;
  set: (items: Record<string, any>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

// Per-origin preferences, one storage.local entry per origin, mirrored in memory
// so the blocking webRequest listeners can answer synchronously.
export class OfflineStore {
  private prefs = new Map<string, OfflinePrefs>();
  private loaded?: Promise<void>;

  constructor(
    private area: StorageArea,
    private makeToken: () => string
  ) {}

  ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.area.get().then((all) => {
        Object.keys(all).forEach((key) => {
          const value = all[key];
          if (
            key.startsWith(KEY_PREFIX) &&
            value &&
            typeof value.token === 'string' &&
            (value.mode === 'off' || isOfflineMode(value.mode))
          ) {
            this.prefs.set(key.slice(KEY_PREFIX.length), value);
          }
        });
      });
    }
    return this.loaded;
  }

  get(origin: string): OfflinePrefs | undefined {
    return this.prefs.get(origin);
  }

  origins(): string[] {
    return Array.from(this.prefs.keys());
  }

  async put(origin: string, prefs: OfflinePrefs): Promise<void> {
    await this.ready();
    this.prefs.set(origin, prefs);
    await this.area.set({ [KEY_PREFIX + origin]: prefs });
  }

  async setMode(
    origin: string,
    mode: OfflineModeSetting
  ): Promise<OfflinePrefs> {
    await this.ready();
    const existing = this.prefs.get(origin);
    const prefs: OfflinePrefs = {
      mode,
      token: existing ? existing.token : this.makeToken(),
    };
    if (mode === 'off') {
      prefs.cleanup = true;
    }
    await this.put(origin, prefs);
    return prefs;
  }

  async delete(origin: string): Promise<void> {
    await this.ready();
    this.prefs.delete(origin);
    await this.area.remove(KEY_PREFIX + origin);
  }
}

export const isEligibleUrl = (url?: string): boolean => {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      return true;
    }
    // browsers treat these as secure contexts, so workers work over http
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname.endsWith('.localhost') ||
        parsed.hostname === '[::1]' ||
        /^127(\.\d{1,3}){3}$/.test(parsed.hostname))
    );
  } catch (error) {
    return false;
  }
};

export const originOf = (url?: string): string | undefined => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch (error) {
    return undefined;
  }
};

export const workerPath = (token: string) =>
  `/?${WORKER_QUERY_PARAM}=${encodeURIComponent(token)}`;

// Code run inside the site's tab (tabs.executeScript). Only JSON-encoded
// constants are interpolated.
export const registerCode = (token: string, update: boolean) =>
  `(function () {
  if (!navigator.serviceWorker) { return 'unsupported'; }
  return navigator.serviceWorker
    .register(${JSON.stringify(workerPath(token))}, { scope: '/' })
    .then(function (registration) {
      return ${update ? 'registration.update().then(function () {}, function () {})' : 'undefined'};
    })
    .then(function () { return 'ok'; }, function (error) {
      return 'error: ' + (error && error.message);
    });
})()`;

export const unregisterCode = () =>
  `(function () {
  if (!navigator.serviceWorker) { return 0; }
  return navigator.serviceWorker.getRegistrations().then(function (list) {
    var ours = list.filter(function (registration) {
      var worker = registration.active || registration.waiting || registration.installing;
      return worker && worker.scriptURL.indexOf(${JSON.stringify(
        '?' + WORKER_QUERY_PARAM + '='
      )}) !== -1;
    });
    return Promise.all(ours.map(function (r) { return r.unregister(); }))
      .then(function () { return ours.length; });
  });
})()`;

export const clearCacheCode = () =>
  `(function () {
  if (!window.caches) { return false; }
  return caches.delete(${JSON.stringify(OFFLINE_CACHE_NAME)});
})()`;

// Code run inside the tab after it loaded: did our worker answer this page
// with a saved copy? Returns null for a live page (or when the worker was not
// in charge of the load, e.g. a hard reload).
export const readStatusCode = () =>
  `(function () {
  if (!window.caches || !navigator.serviceWorker || !navigator.serviceWorker.controller) { return null; }
  var key = ${JSON.stringify(STATUS_KEY_PATH)} + '?u=' + encodeURIComponent(location.href.split('#')[0]);
  return caches.open(${JSON.stringify(OFFLINE_CACHE_NAME)})
    .then(function (cache) { return cache.match(key); })
    .then(function (response) { return response ? response.json() : null; })
    .then(function (info) {
      var started = performance.timeOrigin || (performance.timing && performance.timing.navigationStart) || 0;
      return info && info.at >= started - 1000 ? info : null;
    }, function () { return null; });
})()`;

export type SavedCopyInfo = {
  reason: 'unreachable' | 'notChecked' | number;
  savedAt: number | null;
};

const YEAR = 365 * 24 * 3600 * 1000;

// The record sits in the site's own Cache Storage, which the page itself can
// write, so it is untrusted input: accept only exact, known values.
export const parseSavedCopy = (
  raw: unknown,
  now: number = Date.now()
): SavedCopyInfo | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const { reason, savedAt } = raw as Record<string, unknown>;

  const reasonOk =
    reason === 'unreachable' ||
    reason === 'notChecked' ||
    (typeof reason === 'number' && FALLBACK_STATUSES.indexOf(reason) !== -1);
  if (!reasonOk) {
    return null;
  }

  if (savedAt === null || savedAt === undefined) {
    return { reason: reason as SavedCopyInfo['reason'], savedAt: null };
  }
  if (
    typeof savedAt !== 'number' ||
    !Number.isFinite(savedAt) ||
    savedAt < now - YEAR ||
    savedAt > now + 5 * 60 * 1000
  ) {
    return null;
  }
  return { reason: reason as SavedCopyInfo['reason'], savedAt };
};

export type Indicator = { text: string; title: string };

export const INDICATOR_TEXT = 'OLD';

const clock = (time: number) => {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// What to show on the toolbar button for a saved copy
export const describeSavedCopy = (info: SavedCopyInfo): Indicator => {
  const when = info.savedAt ? ` from ${clock(info.savedAt)}` : '';
  let why = ' (not checked with the site)';
  if (info.reason === 'unreachable') {
    why = ' (site unreachable)';
  } else if (typeof info.reason === 'number') {
    why = ` (site returned ${info.reason})`;
  }
  return {
    text: INDICATOR_TEXT,
    title: `AutoReload: showing saved copy${when}${why}`,
  };
};

export type OfflineTab = { id?: number; url?: string; incognito?: boolean };

export type OfflineDeps = {
  store: OfflineStore;
  executeScript: (tabId: number, code: string) => Promise<unknown>;
  queryTabs: () => Promise<OfflineTab[]>;
  // per-tab toolbar badge and tooltip; null clears them
  setIndicator?: (tabId: number, indicator: Indicator | null) => void;
  log?: (message: string, detail?: unknown) => void;
};

export type OfflineMessage = {
  type: 'offline:get' | 'offline:set' | 'offline:clear';
  origin: string;
  mode?: string;
};

export type OfflineState = { mode: OfflineModeSetting; status?: string };

export const isOfflineMessage = (message: any): message is OfflineMessage =>
  !!message &&
  typeof message.type === 'string' &&
  message.type.startsWith('offline:') &&
  typeof message.origin === 'string';

export default class OfflineModeManager {
  // tabs that currently show a badge
  private flagged = new Set<number>();

  constructor(readonly deps: OfflineDeps) {}

  private indicate(tabId: number, indicator: Indicator | null): void {
    if (!this.deps.setIndicator) {
      return;
    }
    if (indicator) {
      this.flagged.add(tabId);
    } else if (!this.flagged.delete(tabId)) {
      return;
    }
    this.deps.setIndicator(tabId, indicator);
  }

  forgetTab(tabId: number): void {
    this.flagged.delete(tabId);
  }

  private async run(tabId: number, code: string): Promise<unknown> {
    try {
      const results = (await this.deps.executeScript(tabId, code)) as unknown[];
      return results ? results[0] : undefined;
    } catch (error) {
      this.deps.log?.(`Offline mode: could not script tab ${tabId}`, error);
      return 'error: ' + (error as Error)?.message;
    }
  }

  private async tabsOf(origin: string): Promise<OfflineTab[]> {
    return (await this.deps.queryTabs()).filter(
      (tab) =>
        tab.id !== undefined &&
        !tab.incognito &&
        originOf(tab.url) === origin &&
        isEligibleUrl(tab.url)
    );
  }

  async getState(origin: string): Promise<OfflineState> {
    await this.deps.store.ready();
    const prefs = this.deps.store.get(origin);
    return { mode: prefs ? prefs.mode : 'off' };
  }

  async setMode(origin: string, mode: unknown): Promise<OfflineState> {
    const { store } = this.deps;
    if (mode !== 'off' && !isOfflineMode(mode)) {
      return { mode: 'off', status: 'error: unknown mode' };
    }

    if (mode === 'off') {
      await store.ready();
      if (!store.get(origin)) {
        return { mode: 'off' };
      }
      await store.setMode(origin, 'off');
      await this.cleanUp(origin);
      return { mode: 'off' };
    }

    const prefs = await store.setMode(origin, mode);
    const tabs = await this.tabsOf(origin);
    let status =
      'saved; the worker is added the next time a page of the site loads';
    for (const tab of tabs) {
      const result = await this.run(
        tab.id as number,
        registerCode(prefs.token, true)
      );
      status = String(result === 'ok' ? 'active' : result);
    }
    return { mode, status };
  }

  // remove the worker (and saved copies) from every open tab of the origin;
  // forget the origin once that has actually been done
  private async cleanUp(origin: string): Promise<void> {
    const tabs = await this.tabsOf(origin);
    if (!tabs.length) {
      return;
    }
    for (const tab of tabs) {
      await this.run(tab.id as number, unregisterCode());
      await this.run(tab.id as number, clearCacheCode());
    }
    await this.deps.store.delete(origin);
  }

  async clearCopies(origin: string): Promise<number> {
    const tabs = await this.tabsOf(origin);
    let cleared = 0;
    for (const tab of tabs) {
      if ((await this.run(tab.id as number, clearCacheCode())) === true) {
        cleared++;
      }
      // one tab is enough: the cache belongs to the origin
      break;
    }
    return cleared;
  }

  // called when a tab finished loading
  async onTabComplete(tab: OfflineTab): Promise<void> {
    if (tab.id === undefined || tab.incognito || !isEligibleUrl(tab.url)) {
      return;
    }
    const origin = originOf(tab.url);
    if (!origin) {
      return;
    }
    await this.deps.store.ready();
    const prefs = this.deps.store.get(origin);
    if (!prefs) {
      this.indicate(tab.id, null);
      return;
    }
    if (prefs.mode === 'off') {
      if (prefs.cleanup) {
        await this.cleanUp(origin);
      }
      this.indicate(tab.id, null);
      return;
    }
    await this.run(tab.id, registerCode(prefs.token, false));
    await this.refreshIndicator(tab.id);
  }

  // show (or clear) the "saved copy" badge of a tab
  async refreshIndicator(tabId: number): Promise<void> {
    if (!this.deps.setIndicator) {
      return;
    }
    const info = parseSavedCopy(await this.run(tabId, readStatusCode()));
    this.indicate(tabId, info ? describeSavedCopy(info) : null);
  }

  async handleMessage(message: OfflineMessage): Promise<unknown> {
    const origin = message.origin;
    switch (message.type) {
      case 'offline:get':
        return this.getState(origin);
      case 'offline:set':
        return this.setMode(origin, message.mode);
      case 'offline:clear':
        return { cleared: await this.clearCopies(origin) };
      default:
        return undefined;
    }
  }

  // The generated script for a request to the reserved path, but only when the
  // origin has the feature on and the token matches; null otherwise.
  workerScriptFor(url: string, method: string): string | null {
    if (method !== 'GET') {
      return null;
    }
    try {
      const parsed = new URL(url);
      const prefs = this.deps.store.get(parsed.origin);
      if (
        !prefs ||
        prefs.mode === 'off' ||
        parsed.pathname !== '/' ||
        parsed.searchParams.get(WORKER_QUERY_PARAM) !== prefs.token
      ) {
        return null;
      }
      return buildWorkerScript(prefs.mode);
    } catch (error) {
      return null;
    }
  }
}
