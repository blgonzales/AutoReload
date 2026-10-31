import BrowserTab from '../src/util/BrowserTab';
import {
  MIN_RANDOM_DELAY,
  computeDelay,
  randomizeSpreadOptions,
} from '../src/util/randomDelay';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

// keep BrowserTab tests independent of stored settings (empty = all defaults)
jest.mock('../src/server', () => ({
  getSettings: async () => ({}),
}));

const on = (spread: number) => ({
  randomizeInterval: true,
  randomizeSpread: spread,
});
const off = { randomizeInterval: false, randomizeSpread: 0.5 };

describe('computeDelay', () => {
  test('returns the base delay when disabled, whatever the rng says', () => {
    expect(computeDelay(60000, off, () => 0)).toBe(60000);
    expect(computeDelay(1000, off, () => 1)).toBe(1000);
  });

  test('maps rng 0, 0.5, 1 to -spread, 0, +spread', () => {
    expect(computeDelay(60000, on(0.25), () => 0)).toBe(45000);
    expect(computeDelay(60000, on(0.25), () => 0.5)).toBe(60000);
    expect(computeDelay(60000, on(0.25), () => 1)).toBe(75000);
  });

  test('supports all spread options', () => {
    expect(computeDelay(100000, on(0.1), () => 0)).toBe(90000);
    expect(computeDelay(100000, on(0.5), () => 1)).toBe(150000);
  });

  test('never goes below the 5 second floor', () => {
    expect(computeDelay(6000, on(0.5), () => 0)).toBe(MIN_RANDOM_DELAY);
    expect(computeDelay(1000, on(0.1), () => 0.5)).toBe(MIN_RANDOM_DELAY);
  });

  test('stays within bounds for the default rng', () => {
    for (let i = 0; i < 1000; i++) {
      const d = computeDelay(60000, on(0.25));
      expect(d).toBeGreaterThanOrEqual(45000);
      expect(d).toBeLessThanOrEqual(75000);
    }
  });
});

describe('BrowserTab scheduling', () => {
  const interval = { hours: 0, minutes: 1, seconds: 0, millis: 0 };
  const reload = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.useFakeTimers();
    reload.mockClear();
    (global as any).browser = {
      tabs: { reload },
      browserAction: { setIcon: jest.fn() },
    };
  });
  afterEach(() => jest.useRealTimers());

  test('reloads at a fixed period when randomize is off', async () => {
    const tab = new BrowserTab(1, interval, true, async () => off);

    await jest.advanceTimersByTimeAsync(59999);
    expect(reload).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60000);
    expect(reload).toHaveBeenCalledTimes(2);
    tab.clearTimer();
  });

  test('draws a fresh delay after every reload', async () => {
    const rng = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);
    const tab = new BrowserTab(1, interval, true, async () => on(0.5), rng);

    await jest.advanceTimersByTimeAsync(29999);
    expect(reload).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // second delay: 60000 * 1.5 = 90000
    await jest.advanceTimersByTimeAsync(89999);
    expect(reload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(rng).toHaveBeenCalledTimes(3);
    tab.clearTimer();
  });

  test('reads the setting again at each scheduling', async () => {
    const getRandomize = jest
      .fn()
      .mockResolvedValueOnce(on(0.5))
      .mockResolvedValue(off);
    const tab = new BrowserTab(1, interval, true, getRandomize, () => 0);

    await jest.advanceTimersByTimeAsync(30000);
    expect(reload).toHaveBeenCalledTimes(1);
    // switched off meanwhile: plain base interval again
    await jest.advanceTimersByTimeAsync(59999);
    expect(reload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(getRandomize).toHaveBeenCalledTimes(3);
    tab.clearTimer();
  });

  test('clearTimer stops further reloads', async () => {
    const tab = new BrowserTab(1, interval, true, async () => off);
    await jest.advanceTimersByTimeAsync(60000);
    tab.clearTimer();
    await jest.advanceTimersByTimeAsync(300000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(tab.isEnabled()).toBe(false);
  });

  test('clearTimer while the setting is being read cancels scheduling', async () => {
    const tab = new BrowserTab(1, interval, true, async () => off);
    tab.clearTimer();
    await jest.advanceTimersByTimeAsync(300000);
    expect(reload).not.toHaveBeenCalled();
  });

  test('createTimer on an enabled tab throws', () => {
    const tab = new BrowserTab(1, interval, true, async () => off);
    expect(() => tab.createTimer()).toThrow();
    tab.clearTimer();
  });
});

describe('defaults', () => {
  test('randomizing is on by default with a modest spread that is selectable', () => {
    const config = jest.requireActual('../src/config');
    const defaults = config.getAppDefaults();
    expect(defaults.randomizeInterval).toBe(true);
    expect(defaults.randomizeSpread).toBeLessThanOrEqual(0.2);
    expect(randomizeSpreadOptions).toContain(defaults.randomizeSpread);
  });
});
