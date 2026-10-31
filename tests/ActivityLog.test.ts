import {
  ActivityLog,
  diffSettings,
  formatInterval,
  formatSnapshotText,
  hostOf,
  tabInfoFromTab,
  recordSettingsChange,
  ActivitySnapshot,
} from '../src/util/ActivityLog';
import BrowserTab from '../src/util/BrowserTab';
import ReloadManager from '../src/util/ReloadManager';
import {
  ACTIVITY_PORT_NAME,
  attachActivityPort,
  buildSnapshot,
} from '../src/util/ActivityPort';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

const SETTINGS = {
  defaultInterval: { hours: 0, minutes: 1, seconds: 30, millis: 0 },
  defaultIdleTimeout: { hours: 2, minutes: 0, seconds: 0, millis: 0 },
  defaultEnabled: false,
};
const TEN_S = { hours: 0, minutes: 0, seconds: 10, millis: 0 };
const flush = () => new Promise((r) => setImmediate(r));

describe('ActivityLog ring buffer', () => {
  it('keeps entries in order and assigns increasing ids and times', () => {
    let t = 1000;
    const log = new ActivityLog({ now: () => (t += 10) });
    log.record('reload', 'a');
    log.record('error', 'b', { details: 'more' });
    const e = log.getEntries();
    expect(e.map((x) => x.message)).toEqual(['a', 'b']);
    expect(e[0].time).toBeLessThan(e[1].time);
    expect(e[1].id).toBeGreaterThan(e[0].id);
    expect(e[1].details).toBe('more');
  });

  it('drops the oldest entries beyond the cap', () => {
    const log = new ActivityLog({ cap: 3 });
    for (let i = 1; i <= 5; i++) log.record('x', `m${i}`);
    expect(log.getEntries().map((x) => x.message)).toEqual(['m3', 'm4', 'm5']);
  });

  it('defaults to a cap of 500', () => {
    const log = new ActivityLog();
    for (let i = 0; i < 520; i++) log.record('x', `m${i}`);
    expect(log.getEntries()).toHaveLength(500);
    expect(log.getEntries()[0].message).toBe('m20');
  });

  it('clear empties the log and getEntries returns a copy', () => {
    const log = new ActivityLog();
    log.record('x', 'a');
    log.getEntries().pop();
    expect(log.getEntries()).toHaveLength(1);
    log.clear();
    expect(log.getEntries()).toEqual([]);
  });

  it('notifies subscribers until they unsubscribe', () => {
    const log = new ActivityLog();
    const fn = jest.fn();
    const off = log.subscribe(fn);
    log.record('x', 'a');
    log.clear();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    log.record('x', 'b');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('looks up tab title and host, and keeps them after the tab is gone', async () => {
    const getTabInfo = jest
      .fn()
      .mockResolvedValueOnce({
        title: 'Dash',
        url: 'https://example.com/a?token=1',
      })
      .mockRejectedValue(new Error('no tab'));
    const log = new ActivityLog({ getTabInfo });
    const first = log.record('reload', 'r', { tabId: 7 });
    await flush();
    expect(first.tabTitle).toBe('Dash');
    expect(first.host).toBe('example.com');
    const second = log.record('timer-stopped', 's', { tabId: 7 });
    expect(second.tabTitle).toBe('Dash'); // from cache, synchronously
    expect(second.host).toBe('example.com');
    await flush();
    expect(second.tabTitle).toBe('Dash');
  });

  it('hostOf returns only the host', () => {
    expect(hostOf('https://user@example.com:8080/p?q=1#h')).toBe(
      'example.com:8080'
    );
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});

describe('settings diff', () => {
  it('lists changed keys with readable labels, old -> new', () => {
    const changes = diffSettings(SETTINGS, {
      ...SETTINGS,
      defaultInterval: TEN_S,
      defaultEnabled: true,
    });
    expect(changes).toEqual([
      {
        key: 'defaultInterval',
        label: 'Default interval',
        from: '1 min 30 s',
        to: '10 s',
      },
      {
        key: 'defaultEnabled',
        label: 'Default enabled',
        from: 'off',
        to: 'on',
      },
    ]);
  });

  it('reports nothing when equal, and handles unknown keys', () => {
    expect(diffSettings(SETTINGS, { ...SETTINGS })).toEqual([]);
    expect(diffSettings({ a: 1 }, { a: 2 })).toEqual([
      { key: 'a', label: 'a', from: '1', to: '2' },
    ]);
  });

  it('recordSettingsChange writes one entry, none when unchanged', () => {
    const log = new ActivityLog();
    recordSettingsChange(log, SETTINGS, SETTINGS);
    expect(log.getEntries()).toHaveLength(0);
    recordSettingsChange(log, SETTINGS, { ...SETTINGS, defaultEnabled: true });
    const [e] = log.getEntries();
    expect(e.kind).toBe('settings');
    expect(e.message).toBe('Setting changed: Default enabled');
    expect(e.details).toBe('Default enabled: off → on');
  });

  it('formatInterval', () => {
    expect(
      formatInterval({ hours: 2, minutes: 0, seconds: 0, millis: 0 })
    ).toBe('2 h');
    expect(formatInterval(SETTINGS.defaultInterval)).toBe('1 min 30 s');
  });
});

describe('BrowserTab hooks', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = (enabled = false) => {
    const log = new ActivityLog({ now: () => Date.now() });
    const reloadTab = jest.fn().mockResolvedValue(undefined);
    const tab = new BrowserTab(5, TEN_S, enabled, {
      log,
      reloadTab,
      setIcon: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    return { log, reloadTab, tab };
  };
  const kinds = (log: ActivityLog) => log.getEntries().map((e) => e.kind);

  it('logs timer start, each scheduled reload and stop', async () => {
    const { log, tab, reloadTab } = make();
    tab.update({ enabled: true, interval: TEN_S });
    await jest.advanceTimersByTimeAsync(20000);
    expect(reloadTab).toHaveBeenCalledTimes(2);
    tab.update({ enabled: false, interval: TEN_S });
    expect(kinds(log)).toEqual([
      'timer-started',
      'reload',
      'reload',
      'timer-stopped',
    ]);
    const [started, r1, , stopped] = log.getEntries();
    expect(started.message).toContain('every 10 s');
    expect(started.message).toContain('turned on in the popup');
    expect(r1.message).toContain('scheduled');
    expect(stopped.message).toContain('turned off in the popup');
    expect(started.tabId).toBe(5);
  });

  it('logs a changed interval as one restart', () => {
    const { log, tab } = make(true);
    tab.update({ enabled: true, interval: { ...TEN_S, seconds: 30 } });
    const msgs = log.getEntries().map((e) => e.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toContain('every 30 s');
    expect(msgs[1]).toContain('interval changed from 10 s');
  });

  it('records "enabled by default" when created enabled', () => {
    const { log } = make(true);
    expect(log.getEntries()[0].message).toContain('Default enabled');
  });

  it('exposes the next reload time and clears it when stopped', async () => {
    const { tab } = make();
    expect(tab.getNextReloadAt()).toBeNull();
    tab.createTimer();
    const first = tab.getNextReloadAt() as number;
    await jest.advanceTimersByTimeAsync(10000);
    expect(tab.getNextReloadAt()).toBeGreaterThan(first);
    tab.clearTimer();
    expect(tab.getNextReloadAt()).toBeNull();
  });

  it('does not log a stop for a timer that was not running', () => {
    const { log, tab } = make();
    tab.clearTimer();
    expect(log.getEntries()).toHaveLength(0);
  });

  it('records a failed reload as an error entry', async () => {
    const { log, tab, reloadTab } = make();
    reloadTab.mockRejectedValue(new Error('tab gone'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await tab.reload();
    spy.mockRestore();
    const e = log.getEntries()[0];
    expect(e.kind).toBe('error');
    expect(e.message).toContain('tab gone');
  });

  it('labels a manual reload', async () => {
    const { log, tab } = make();
    await tab.reload('manual');
    expect(log.getEntries()[0].message).toBe('Reloaded (manual)');
  });
});

describe('ReloadManager hooks', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = () => {
    const log = new ActivityLog({ now: () => Date.now() });
    const manager = new ReloadManager({
      log,
      tabDeps: {
        reloadTab: jest.fn().mockResolvedValue(undefined),
        setIcon: jest.fn(),
        sleep: jest.fn().mockResolvedValue(undefined),
      },
    });
    (manager as any).getCurrentTabId = jest.fn().mockResolvedValue(3);
    return { log, manager };
  };

  it('logs global on/off and the per-tab timers it causes', async () => {
    const { log, manager } = make();
    await manager.getOrCreateBrowserTab({ ...SETTINGS, defaultEnabled: true });
    log.clear();
    manager.update({ enabled: false } as any);
    manager.update({ enabled: true } as any);
    expect(log.getEntries().map((e) => e.message)).toEqual([
      'Global switch turned off for 1 registered tab(s)',
      'Timer stopped (global switch turned off)',
      'Global switch turned on for 1 registered tab(s)',
      expect.stringContaining('global switch turned on'),
    ]);
  });

  it('logs a closed tab', async () => {
    const { log, manager } = make();
    const tab = (await manager.getOrCreateBrowserTab({
      ...SETTINGS,
      defaultEnabled: true,
    }))!;
    manager.deleteBrowserTab(tab);
    expect(log.getEntries().pop()!.message).toBe('Timer stopped (tab closed)');
    expect(manager.getNumberOfTabs()).toBe(0);
  });

  it('logs idle pause and reports the idle status', async () => {
    const { log, manager } = make();
    await manager.getOrCreateBrowserTab({ ...SETTINGS, defaultEnabled: true });
    log.clear();
    expect(manager.getIdleStatus().state).toBe('active');
    manager.createIdleTimer(60000);
    expect(manager.getIdleStatus().state).toBe('idle-pending');
    await jest.advanceTimersByTimeAsync(60000);
    expect(log.getEntries().map((e) => e.kind)).toEqual([
      'idle',
      'idle',
      'timer-stopped',
    ]);
    expect(log.getEntries()[1].message).toContain('pausing 1 running tab(s)');
    expect(manager.getIdleStatus().state).toBe('paused-by-idle');
    manager.clearIdlePause();
    expect(manager.getIdleStatus().state).toBe('active');
  });

  it('cancelIdleTimer reports whether a timer was pending', () => {
    const { manager } = make();
    expect(manager.cancelIdleTimer()).toBe(false);
    manager.createIdleTimer(1000);
    expect(manager.cancelIdleTimer()).toBe(true);
    expect(manager.getIdleStatus().state).toBe('active');
  });
});

describe('activity port and summary', () => {
  const setup = async () => {
    const log = new ActivityLog();
    const manager = new ReloadManager({
      log,
      tabDeps: {
        reloadTab: jest.fn(),
        setIcon: jest.fn(),
        sleep: jest.fn().mockResolvedValue(undefined),
      },
    });
    (manager as any).getCurrentTabId = jest.fn().mockResolvedValue(3);
    const deps = {
      log,
      manager,
      getSettings: jest.fn().mockResolvedValue(SETTINGS),
      getTabInfo: jest.fn().mockResolvedValue({
        title: 'Board',
        url: 'https://example.com/x?y=1',
      }),
      version: '9.9.9',
    };
    return { log, manager, deps };
  };

  it('summarises only enabled tabs, with host and interval', async () => {
    jest.useFakeTimers();
    const { manager, deps } = await setup();
    const tab = (await manager.getOrCreateBrowserTab({
      ...SETTINGS,
      defaultEnabled: true,
    }))!;
    tab.update({ enabled: true, interval: TEN_S });
    const snap = await buildSnapshot(deps);
    expect(snap.summary.version).toBe('9.9.9');
    expect(snap.summary.enabledTabs).toBe(1);
    expect(snap.summary.tabs).toEqual([
      expect.objectContaining({
        tabId: 3,
        title: 'Board',
        host: 'example.com',
        intervalMs: 10000,
      }),
    ]);
    expect(snap.summary.tabs[0].nextReloadAt).toBeGreaterThan(snap.now);
    tab.clearTimer();
    expect((await buildSnapshot(deps)).summary.tabs).toEqual([]);
    jest.useRealTimers();
  });

  it('streams snapshots to the page, handles clear, and stops on disconnect', async () => {
    const { log, deps } = await setup();
    let onMsg: (m: any) => void = () => {};
    let onDisc: () => void = () => {};
    const sent: ActivitySnapshot[] = [];
    const clearIv = jest.fn();
    const port = {
      name: ACTIVITY_PORT_NAME,
      postMessage: (m: any) => sent.push(m),
      onMessage: { addListener: (l: any) => (onMsg = l) },
      onDisconnect: { addListener: (l: any) => (onDisc = l) },
    };
    attachActivityPort(port, {
      ...deps,
      setInterval: jest.fn().mockReturnValue(1 as any),
      clearInterval: clearIv,
    });
    await flush();
    expect(sent).toHaveLength(1);

    log.record('reload', 'x');
    await flush();
    expect(sent[sent.length - 1].entries).toHaveLength(1);

    onMsg({ type: 'clear' });
    await flush();
    expect(log.getEntries()).toEqual([]);
    expect(sent[sent.length - 1].entries).toEqual([]);

    onDisc();
    const n = sent.length;
    log.record('reload', 'y');
    await flush();
    expect(sent).toHaveLength(n);
    expect(clearIv).toHaveBeenCalledWith(1);
  });

  it('ignores ports with another name', () => {
    const port = {
      name: 'other',
      postMessage: jest.fn(),
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
    };
    attachActivityPort(port, {} as any);
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });
});

describe('plain text export', () => {
  it('lists newest first, host only unless full URLs requested', () => {
    const log = new ActivityLog({
      now: () => new Date(2026, 9, 31, 12, 0, 0).getTime(),
    });
    log.record('reload', 'Reloaded', {
      tabId: 1,
      tabTitle: 'Board',
      url: 'https://example.com/p?q=1',
    });
    log.record('settings', 'Setting changed', { details: 'a: 1 → 2' });
    const snap: ActivitySnapshot = {
      now: 0,
      startedAt: 0,
      cap: 500,
      entries: log.getEntries(),
      summary: {
        version: '1',
        trackedTabs: 0,
        enabledTabs: 0,
        globalEnabled: false,
        idle: { state: 'active' },
        defaultInterval: SETTINGS.defaultInterval,
        defaultIdleTimeout: SETTINGS.defaultIdleTimeout,
        defaultEnabled: false,
        tabs: [],
      },
    };
    const hostOnly = formatSnapshotText(snap);
    expect(hostOnly).toContain('Board - example.com (tab 1): Reloaded');
    expect(hostOnly).not.toContain('q=1');
    expect(hostOnly.indexOf('Setting changed')).toBeLessThan(
      hostOnly.indexOf('Reloaded')
    );
    expect(hostOnly).toContain('    a: 1 → 2');
    expect(formatSnapshotText(snap, { fullUrls: true })).toContain(
      'https://example.com/p?q=1'
    );
  });
});

describe('private-window tabs', () => {
  const SECRET_URL = 'https://secret.example.org/inbox?id=42';
  const SECRET_TITLE = 'My secret inbox';
  const fromTab = (tab: any) => async () => tabInfoFromTab(tab);
  const dump = (o: unknown) => JSON.stringify(o);

  it('redacts title and address of an incognito tab', async () => {
    const log = new ActivityLog({
      getTabInfo: fromTab({
        title: SECRET_TITLE,
        url: SECRET_URL,
        incognito: true,
      }),
    });
    const e = log.record('reload', 'Reloaded (manual)', { tabId: 4 });
    await flush();
    const e2 = log.record('timer-stopped', 'Timer stopped (x)', { tabId: 4 });
    expect(e.tabTitle).toBe('Private tab');
    expect(e2.tabTitle).toBe('Private tab');
    expect(e.tabId).toBe(4);
    expect(e.url).toBeUndefined();
    expect(e.host).toBeUndefined();
    expect(e.message).toBe('Reloaded (manual)');
    const text = dump(log.getEntries());
    expect(text).not.toContain('secret');
    expect(
      formatSnapshotText(
        {
          now: 0,
          startedAt: 0,
          cap: 5,
          entries: log.getEntries(),
          summary: {
            version: '1',
            trackedTabs: 0,
            enabledTabs: 0,
            globalEnabled: false,
            idle: { state: 'active' },
            defaultInterval: SETTINGS.defaultInterval,
            defaultIdleTimeout: SETTINGS.defaultIdleTimeout,
            defaultEnabled: false,
            tabs: [],
          },
        },
        { fullUrls: true }
      )
    ).toContain('Private tab (tab 4)');
  });

  it('treats unknown privacy as private', async () => {
    for (const tab of [
      { title: SECRET_TITLE, url: SECRET_URL },
      { title: SECRET_TITLE, url: SECRET_URL, incognito: undefined },
    ]) {
      const log = new ActivityLog({ getTabInfo: fromTab(tab) });
      log.record('reload', 'r', { tabId: 1 });
      await flush();
      expect(dump(log.getEntries())).not.toContain('secret');
      expect(log.getEntries()[0].tabTitle).toBe('Private tab');
    }
    const throwing = new ActivityLog({
      getTabInfo: jest.fn().mockRejectedValue(new Error('no tab')),
    });
    throwing.record('reload', 'r', { tabId: 2 });
    await flush();
    expect(throwing.getEntries()[0].tabTitle).toBe('Private tab');
  });

  it('leaves normal tabs unchanged', async () => {
    const log = new ActivityLog({
      getTabInfo: fromTab({
        title: 'Dash',
        url: 'https://example.com/a',
        incognito: false,
      }),
    });
    const e = log.record('reload', 'r', { tabId: 5 });
    await flush();
    expect(e.tabTitle).toBe('Dash');
    expect(e.host).toBe('example.com');
    expect(e.url).toBe('https://example.com/a');
    expect(e.private).toBeUndefined();
  });

  it('keeps addresses out of messages for private tabs', async () => {
    const log = new ActivityLog({
      getTabInfo: fromTab({
        title: SECRET_TITLE,
        url: SECRET_URL,
        incognito: true,
      }),
    });
    const e = log.record(
      'error',
      `Reload failed: Error: cannot reload ${SECRET_URL}`,
      {
        tabId: 9,
        details: `from ${SECRET_URL}`,
      }
    );
    expect(e.message).not.toContain('secret.example.org');
    await flush();
    const e2 = log.record('error', `Retrying ${SECRET_URL}`, { tabId: 9 });
    expect(e2.message).not.toContain('secret.example.org');
    expect(dump(log.getEntries())).not.toContain('secret');
  });

  it('keeps private tabs out of the summary', async () => {
    jest.useFakeTimers();
    const log = new ActivityLog();
    const manager = new ReloadManager({
      log,
      tabDeps: {
        reloadTab: jest.fn(),
        setIcon: jest.fn(),
        sleep: jest.fn().mockResolvedValue(undefined),
      },
    });
    (manager as any).getCurrentTabId = jest.fn().mockResolvedValue(3);
    const tab = (await manager.getOrCreateBrowserTab({
      ...SETTINGS,
      defaultEnabled: true,
    }))!;
    tab.update({ enabled: true, interval: TEN_S });
    for (const t of [
      { title: SECRET_TITLE, url: SECRET_URL, incognito: true },
      { title: SECRET_TITLE, url: SECRET_URL },
    ]) {
      const snap = await buildSnapshot({
        log,
        manager,
        version: '1',
        getSettings: jest.fn().mockResolvedValue(SETTINGS),
        getTabInfo: async () => tabInfoFromTab(t),
      });
      expect(snap.summary.tabs[0]).toEqual(
        expect.objectContaining({ tabId: 3, title: 'Private tab' })
      );
      expect(dump(snap)).not.toContain('secret');
    }
    const snap = await buildSnapshot({
      log,
      manager,
      version: '1',
      getSettings: jest.fn().mockResolvedValue(SETTINGS),
      getTabInfo: jest.fn().mockRejectedValue(new Error('x')),
    });
    expect(snap.summary.tabs[0].title).toBe('Private tab');
    tab.clearTimer();
    jest.useRealTimers();
  });
});
