import CountdownTicker, {
  describeTab,
  formatCountdown,
  formatDuration,
} from '../src/util/Countdown';
import ReloadManager, { PAUSED_STORAGE_KEY } from '../src/util/ReloadManager';
import { getAppDefaults } from '../src/config';

describe('formatCountdown', () => {
  test.each([
    [-5, '0s'],
    [0, '0s'],
    [1, '1s'],
    [1000, '1s'],
    [1001, '2s'],
    [59000, '59s'],
    [60000, '60s'],
    [120000, '120s'],
    [60001, '61s'],
    [120001, '3m'],
    [240000, '4m'],
    [3599000, '60m'],
    [3600000, '60m'],
    [3600001, '2h'],
    [7200000, '2h'],
    [99 * 3600000, '99h'],
    [99 * 3600000 + 1, '99h+'],
  ])('%d ms -> %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
    expect(text.length).toBeLessThanOrEqual(4);
  });
});

describe('CountdownTicker', () => {
  const setup = () => {
    const deps = {
      onTick: jest.fn(),
      onStop: jest.fn(),
      setInterval: jest.fn().mockReturnValue(42),
      clearInterval: jest.fn(),
    };
    return { deps, ticker: new CountdownTicker(deps) };
  };

  test('does not start when the setting is off', () => {
    const { deps, ticker } = setup();
    ticker.sync(false, 3);
    expect(ticker.isRunning()).toBe(false);
    expect(deps.setInterval).not.toHaveBeenCalled();
  });

  test('does not start without enabled tabs', () => {
    const { deps, ticker } = setup();
    ticker.sync(true, 0);
    expect(deps.setInterval).not.toHaveBeenCalled();
  });

  test('starts once at 1s and ticks immediately', () => {
    const { deps, ticker } = setup();
    ticker.sync(true, 1);
    ticker.sync(true, 2);
    expect(deps.setInterval).toHaveBeenCalledTimes(1);
    expect(deps.setInterval).toHaveBeenCalledWith(deps.onTick, 1000);
    expect(deps.onTick).toHaveBeenCalledTimes(2);
    expect(ticker.isRunning()).toBe(true);
  });

  test('stops and clears when the last tab is disabled', () => {
    const { deps, ticker } = setup();
    ticker.sync(true, 1);
    ticker.sync(true, 0);
    expect(deps.clearInterval).toHaveBeenCalledWith(42);
    expect(deps.onStop).toHaveBeenCalledTimes(1);
    expect(ticker.isRunning()).toBe(false);
  });

  test('stops when the setting is turned off, and can restart', () => {
    const { deps, ticker } = setup();
    ticker.sync(true, 1);
    ticker.sync(false, 1);
    expect(deps.onStop).toHaveBeenCalledTimes(1);
    ticker.sync(true, 1);
    expect(deps.setInterval).toHaveBeenCalledTimes(2);
  });
});

describe('countdown badge default', () => {
  test('is on by default so a running tab is visible', () => {
    expect(getAppDefaults().showCountdown).toBe(true);
  });
});

describe('formatDuration', () => {
  test.each([
    [0, '0 s'],
    [42000, '42 s'],
    [90000, '1 min 30 s'],
    [120000, '2 min'],
    [3600000, '1 h'],
    [7500000, '2 h 5 min'],
  ])('%d ms -> %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('describeTab', () => {
  test('running tab shows countdown, interval and time left', () => {
    const d = describeTab({
      kind: 'running',
      intervalMs: 90000,
      remainingMs: 41200,
    });
    expect(d.badge).toBe('42s');
    expect(d.title).toBe(
      'AutoReload: reloading every 1 min 30 s — next in 41 s'
    );
    expect(d.color).not.toBe('');
  });

  test('off, paused and retrying are distinguishable', () => {
    expect(describeTab({ kind: 'off' })).toEqual({
      badge: '',
      title: 'AutoReload: off for this tab',
      color: '',
    });
    expect(describeTab({ kind: 'off', allTabsOff: true }).title).toBe(
      'AutoReload is switched off for all tabs'
    );
    const paused = describeTab({ kind: 'paused' });
    expect(paused.badge).toBe('II');
    expect(paused.title).toBe("AutoReload: paused (you're away)");
    expect(describeTab({ kind: 'retrying' }).badge).toBe('R');
  });
});

describe('ReloadManager indicators', () => {
  const setupBrowser = () => {
    const calls: any = { text: [], title: [], color: [], tabId: 0 };
    (global as any).browser = {
      storage: { sync: { get: jest.fn(async () => ({})) } },
      tabs: { query: jest.fn(async () => [{ id: calls.tabId }]) },
      browserAction: {
        setBadgeText: jest.fn((a) => calls.text.push(a)),
        setTitle: jest.fn((a) => calls.title.push(a)),
        setBadgeBackgroundColor: jest.fn((a) => calls.color.push(a)),
        setBadgeTextColor: jest.fn(),
      },
    };
    return calls;
  };

  const startTab = async (
    manager: ReloadManager,
    calls: any,
    id: number,
    interval: any
  ) => {
    calls.tabId = id;
    const tab = await manager.getOrCreateBrowserTab({
      defaultInterval: interval,
      defaultEnabled: true,
    } as any);
    // let an async timer start (random interval) finish scheduling
    await jest.advanceTimersByTimeAsync(0);
    manager.syncCountdown();
    return tab!;
  };

  afterEach(() => {
    jest.useRealTimers();
    delete (global as any).browser;
  });

  test('a running tab gets a badge and tooltip; idle pause keeps showing it', async () => {
    jest.useFakeTimers();
    const calls = setupBrowser();
    const manager = new ReloadManager();
    manager.setShowCountdown(true);
    await startTab(manager, calls, 7, {
      hours: 0,
      minutes: 0,
      seconds: 30,
      millis: 0,
    });

    const last = (list: any[]) => list[list.length - 1];
    expect(last(calls.text)).toEqual({ text: '30s', tabId: 7 });
    expect(last(calls.title).title).toContain('reloading every 30 s');

    manager.pauseForIdle();
    expect(manager.getNumberOfEnabledTabs()).toBe(0);
    expect(last(calls.text)).toEqual({ text: 'II', tabId: 7 });
    expect(last(calls.title).title).toBe("AutoReload: paused (you're away)");

    // turning the tab on again clears the paused state
    manager.getBrowserTab(7)!.update({
      enabled: true,
      interval: {
        hours: 0,
        minutes: 0,
        seconds: 30,
        millis: 0,
      },
    });
    await jest.advanceTimersByTimeAsync(0);
    manager.syncCountdown();
    expect(last(calls.text).text).toBe('30s');
    manager.remove();
  });

  test('a pending retry shows R even while paused for idle, then II again', async () => {
    jest.useFakeTimers();
    const calls = setupBrowser();
    const manager = new ReloadManager();
    manager.setShowCountdown(true);
    let retrying = false;
    manager.setRetryProbe(() => retrying);
    await startTab(manager, calls, 5, {
      hours: 0,
      minutes: 1,
      seconds: 0,
      millis: 0,
    });
    manager.pauseForIdle();
    const last = () => calls.text[calls.text.length - 1];
    expect(last()).toEqual({ text: 'II', tabId: 5 });

    retrying = true;
    await jest.advanceTimersByTimeAsync(1000);
    expect(last()).toEqual({ text: 'R', tabId: 5 });

    retrying = false; // the retry succeeded
    await jest.advanceTimersByTimeAsync(1000);
    expect(last()).toEqual({ text: 'II', tabId: 5 });
    expect(manager.getNumberOfEnabledTabs()).toBe(0);
    manager.remove();
  });

  test('retry probe shows R and setting off clears everything', async () => {
    jest.useFakeTimers();
    const calls = setupBrowser();
    const manager = new ReloadManager();
    manager.setShowCountdown(true);
    manager.setRetryProbe((id) => id === 3);
    await startTab(manager, calls, 3, {
      hours: 0,
      minutes: 1,
      seconds: 0,
      millis: 0,
    });
    expect(calls.text[calls.text.length - 1]).toEqual({ text: 'R', tabId: 3 });

    // a disabled tab says so in its tooltip while the feature is on
    manager.getBrowserTab(3)!.update({
      enabled: false,
      interval: { hours: 0, minutes: 1, seconds: 0, millis: 0 },
    });
    manager.syncCountdown();
    expect(calls.title[calls.title.length - 1]).toEqual({
      title: 'AutoReload: off for this tab',
      tabId: 3,
    });

    manager.setShowCountdown(false);
    expect(calls.text[calls.text.length - 1]).toEqual({ text: '', tabId: 3 });
    expect(calls.title[calls.title.length - 1]).toEqual({
      title: null,
      tabId: 3,
    });
    manager.remove();
  });
});

describe('idle pause and resume', () => {
  const interval = { hours: 0, minutes: 0, seconds: 30, millis: 0 };
  const setup = async () => {
    jest.useFakeTimers();
    const calls: any = { text: [], title: [], color: [], tabId: 0 };
    (global as any).browser = {
      storage: { sync: { get: jest.fn(async () => ({})) } },
      tabs: { query: jest.fn(async () => [{ id: calls.tabId }]) },
      browserAction: {
        setBadgeText: jest.fn((a) => calls.text.push(a)),
        setTitle: jest.fn(),
        setBadgeBackgroundColor: jest.fn(),
        setBadgeTextColor: jest.fn(),
      },
    };
    const saved: any[] = [];
    const manager = new ReloadManager();
    manager.setPauseStore({
      get: async () => ({}),
      set: async (items) => {
        saved.push(items);
      },
    });
    manager.setShowCountdown(true);
    const open = async (id: number) => {
      calls.tabId = id;
      const tab = await manager.getOrCreateBrowserTab({
        defaultInterval: interval,
        defaultEnabled: true,
      } as any);
      await jest.advanceTimersByTimeAsync(0);
      return tab!;
    };
    return { manager, saved, open, calls };
  };

  afterEach(() => {
    jest.useRealTimers();
    delete (global as any).browser;
  });

  test('resumes only the tabs the idle pause switched off', async () => {
    const { manager, open } = await setup();
    const byIdle = await open(1);
    const byHand = await open(2);
    byHand.update({ enabled: false, interval }); // the user switched it off
    expect(byHand.isPausedByIdle()).toBe(false);

    manager.pauseForIdle();
    expect(byIdle.isPausedByIdle()).toBe(true);
    expect(byHand.isPausedByIdle()).toBe(false);
    expect(manager.getNumberOfEnabledTabs()).toBe(0);

    expect(manager.resumeFromIdle()).toBe(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(byIdle.isEnabled()).toBe(true);
    expect(byIdle.isPausedByIdle()).toBe(false);
    expect(byHand.isEnabled()).toBe(false);
    manager.remove();
  });

  test('switching a paused tab off by hand cancels its resume', async () => {
    const { manager, open } = await setup();
    const tab = await open(1);
    manager.pauseForIdle();
    tab.update({ enabled: false, interval });
    expect(manager.resumeFromIdle()).toBe(0);
    expect(tab.isEnabled()).toBe(false);
    manager.remove();
  });

  test('a resumed tab gets a fresh countdown', async () => {
    const { manager, open } = await setup();
    const tab = await open(1);
    manager.pauseForIdle();
    await jest.advanceTimersByTimeAsync(600000); // away for 10 minutes
    manager.resumeFromIdle();
    await jest.advanceTimersByTimeAsync(0);
    const left = tab.getNextReloadAt()! - Date.now();
    expect(left).toBeGreaterThan(25000);
    expect(left).toBeLessThanOrEqual(30000);
    manager.remove();
  });

  test('paused tabs are saved and restored after a background restart', async () => {
    const { manager, saved, open } = await setup();
    await open(4);
    manager.pauseForIdle();
    const record = saved[saved.length - 1][PAUSED_STORAGE_KEY];
    expect(Object.keys(record)).toEqual(['4']);
    expect(record[4].interval).toEqual(interval);

    // a fresh background page: same tab id still exists, tab 9 is gone
    const reborn = new ReloadManager();
    reborn.setShowCountdown(true);
    reborn.restorePaused({ ...record, 9: record[4] }, [4]);
    expect(reborn.getBrowserTab(4)!.isPausedByIdle()).toBe(true);
    expect(reborn.getBrowserTab(9)).toBeNull();
    expect(reborn.getBrowserTab(4)!.getPausedSince()).toBe(record[4].since);
    expect(reborn.resumeFromIdle()).toBe(1);
    expect(reborn.getBrowserTab(4)!.isEnabled()).toBe(true);
    reborn.remove();
    manager.remove();
  });
});
