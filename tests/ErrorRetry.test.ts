import ErrorRetry, {
  ErrorRetryDeps,
  NO_LIMIT_DELAY_MS,
  RetryOptions,
  computeRetryDelay,
  parseRetryAfter,
  parseStatusCodes,
  UnreportedNavigations,
} from '../src/util/ErrorRetry';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

const URL = 'https://example.com/slow';

const OPTIONS: RetryOptions = {
  enabled: true,
  statusCodes: [502, 503, 504],
  delay: 10000,
  backoff: false,
  maxDelay: 60000,
};

const setup = (
  options: Partial<RetryOptions> = {},
  overrides: Partial<ErrorRetryDeps> = {}
) => {
  const deps = {
    getOptions: jest.fn().mockResolvedValue({ ...OPTIONS, ...options }),
    getTabUrl: jest.fn().mockResolvedValue(URL),
    reloadTab: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as {
    getOptions: jest.Mock;
    getTabUrl: jest.Mock;
    reloadTab: jest.Mock;
  };
  return { deps, retry: new ErrorRetry(deps) };
};

// fire `count` failures in a row and return the delay before each retry
const delaysFor = async (
  retry: ErrorRetry,
  deps: { reloadTab: jest.Mock },
  count: number,
  status = 504
) => {
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    await retry.onMainFrameCompleted(1, URL, status);
    const before = deps.reloadTab.mock.calls.length;
    let waited = 0;
    while (deps.reloadTab.mock.calls.length === before && waited < 1e7) {
      await jest.advanceTimersByTimeAsync(1000);
      waited += 1000;
    }
    delays.push(waited);
  }
  return delays;
};

describe('ErrorRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('reloads the tab after the configured delay', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(1, URL, 504);
    jest.advanceTimersByTime(9999);
    expect(deps.reloadTab).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(deps.reloadTab).toHaveBeenCalledWith(1);
    expect(retry.hasPendingRetry(1)).toBe(false);
  });

  test('retries every selected status code, including custom ones', async () => {
    const { deps, retry } = setup({ statusCodes: [418, 429, 503] });

    for (const [tab, code] of [
      [1, 418],
      [2, 429],
      [3, 503],
    ]) {
      await retry.onMainFrameCompleted(tab, URL, code);
    }
    await jest.runAllTimersAsync();
    expect(deps.reloadTab.mock.calls.map((c: number[]) => c[0])).toEqual([
      1, 2, 3,
    ]);
  });

  test('ignores status codes that are not selected', async () => {
    const { deps, retry } = setup({ statusCodes: [503] });

    await retry.onMainFrameCompleted(1, URL, 504);
    await retry.onMainFrameCompleted(1, URL, 500);
    await jest.runAllTimersAsync();
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  test('does nothing when the setting is disabled', async () => {
    const { deps, retry } = setup({ enabled: false, delay: 10 });

    await retry.onMainFrameCompleted(1, URL, 504);
    await jest.runAllTimersAsync();
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  test('a successful load cancels a pending retry', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(1, URL, 504);
    expect(retry.hasPendingRetry(1)).toBe(true);
    await retry.onMainFrameCompleted(1, URL, 200);
    expect(retry.hasPendingRetry(1)).toBe(false);

    await jest.runAllTimersAsync();
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  test('without backoff every retry uses the same delay', async () => {
    const { deps, retry } = setup();
    expect(await delaysFor(retry, deps, 4)).toEqual([
      10000, 10000, 10000, 10000,
    ]);
  });

  test('with backoff the delay doubles up to the limit', async () => {
    const { deps, retry } = setup({ backoff: true, maxDelay: 60000 });
    expect(await delaysFor(retry, deps, 5)).toEqual([
      10000, 20000, 40000, 60000, 60000,
    ]);
  });

  test('backoff starts over after the page loads', async () => {
    const { deps, retry } = setup({ backoff: true });

    await delaysFor(retry, deps, 3);
    expect(retry.getAttempt(1)).toBe(3);
    await retry.onMainFrameCompleted(1, URL, 200);
    expect(retry.getAttempt(1)).toBe(0);
    expect(await delaysFor(retry, deps, 1)).toEqual([10000]);
  });

  test('backoff starts over for a different url', async () => {
    const { deps, retry } = setup({ backoff: true });

    await delaysFor(retry, deps, 2);
    await retry.onMainFrameCompleted(1, 'https://example.com/other', 504);
    expect(retry.getAttempt(1)).toBe(1);
    expect(deps.reloadTab).toHaveBeenCalledTimes(2);
  });

  test('a longer Retry-After header from the server wins', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(1, URL, 503, 'GET', '120');
    await jest.advanceTimersByTimeAsync(119000);
    expect(deps.reloadTab).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
  });

  test('a repeated failure replaces the pending timer instead of stacking', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(1, URL, 504);
    await retry.onMainFrameCompleted(1, URL, 504);
    await jest.runAllTimersAsync();

    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
  });

  test('never replays a POST, and a POST cancels a pending GET retry', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(1, URL, 504, 'POST');
    expect(retry.hasPendingRetry(1)).toBe(false);

    await retry.onMainFrameCompleted(1, URL, 504, 'GET');
    await retry.onMainFrameCompleted(1, URL, 504, 'POST');
    await jest.runAllTimersAsync();
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  test('skips the retry if the tab navigated elsewhere', async () => {
    const { deps, retry } = setup(
      {},
      { getTabUrl: jest.fn().mockResolvedValue('https://example.com/other') }
    );

    await retry.onMainFrameCompleted(1, URL, 504);
    await jest.runAllTimersAsync();
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  test('forget and forgetAll drop pending retries', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(1, URL, 504);
    await retry.onMainFrameCompleted(2, URL, 504);
    retry.forget(1);
    expect(retry.hasPendingRetry(1)).toBe(false);
    expect(retry.hasPendingRetry(2)).toBe(true);
    retry.forgetAll();

    await jest.runAllTimersAsync();
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  test('ignores requests that do not belong to a tab', async () => {
    const { deps, retry } = setup();

    await retry.onMainFrameCompleted(-1, URL, 504);
    expect(deps.getOptions).not.toHaveBeenCalled();
  });

  test('a failed reload (closed tab) does not throw', async () => {
    const { retry } = setup(
      {},
      { getTabUrl: jest.fn().mockRejectedValue(new Error('Invalid tab ID')) }
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await retry.onMainFrameCompleted(1, URL, 504);
    await jest.runAllTimersAsync();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('computeRetryDelay', () => {
  const base = { delay: 5000, backoff: true, maxDelay: 30000 };

  test('doubles per attempt and caps at maxDelay', () => {
    expect([0, 1, 2, 3, 4].map((a) => computeRetryDelay(base, a))).toEqual([
      5000, 10000, 20000, 30000, 30000,
    ]);
  });

  test('a limit below the first delay never shortens it', () => {
    expect(computeRetryDelay({ ...base, maxDelay: 1000 }, 3)).toBe(5000);
  });

  test('huge attempt counts do not overflow', () => {
    expect(computeRetryDelay(base, 5000)).toBe(30000);
  });

  test('Retry-After only lengthens, and is ignored beyond one hour', () => {
    expect(computeRetryDelay(base, 0, 2000)).toBe(5000);
    expect(computeRetryDelay(base, 0, 90000)).toBe(90000);
    expect(computeRetryDelay(base, 0, 7200000)).toBe(5000);
  });
});

describe('parseRetryAfter', () => {
  test('parses delay-seconds and HTTP-dates', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120000);
    expect(parseRetryAfter('Sat, 31 Oct 2026 12:01:00 GMT', now)).toBe(60000);
    expect(parseRetryAfter('Sat, 31 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  test('returns undefined for missing or bad values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('parseStatusCodes', () => {
  test('accepts codes and ranges separated by commas or spaces', () => {
    expect(parseStatusCodes('418, 525-527 599;429')).toEqual({
      codes: [418, 429, 525, 526, 527, 599],
      invalid: [],
    });
  });

  test('drops duplicates and reports invalid entries', () => {
    expect(parseStatusCodes('503 503 200 abc 610 530-520 5000')).toEqual({
      codes: [503],
      invalid: ['200', 'abc', '610', '530-520', '5000'],
    });
  });

  test('empty input gives no codes', () => {
    expect(parseStatusCodes('  ')).toEqual({ codes: [], invalid: [] });
  });
});

describe('UnreportedNavigations', () => {
  test('a navigation reported by webRequest is not returned', () => {
    const navs = new UnreportedNavigations();
    navs.onStarted(1, URL, 'GET');
    navs.onReported(1);
    expect(navs.takeUnreported(1)).toBeUndefined();
  });

  test('a navigation answered by a service worker is returned once', () => {
    const navs = new UnreportedNavigations();
    navs.onStarted(1, URL, 'GET');
    expect(navs.takeUnreported(1)).toEqual({ url: URL, method: 'GET' });
    expect(navs.takeUnreported(1)).toBeUndefined();
  });

  test('keeps the method so a POST is still never replayed', () => {
    const navs = new UnreportedNavigations();
    navs.onStarted(2, URL, 'POST');
    expect(navs.takeUnreported(2)?.method).toBe('POST');
  });

  test('ignores requests without a tab, and forget drops a tab', () => {
    const navs = new UnreportedNavigations();
    navs.onStarted(-1, URL, 'GET');
    expect(navs.takeUnreported(-1)).toBeUndefined();
    navs.onStarted(3, URL, 'GET');
    navs.forget(3);
    expect(navs.takeUnreported(3)).toBeUndefined();
  });
});

describe('no limit and attempt cap', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('maxDelay 0 means no limit: backoff keeps growing up to a day', () => {
    const base = { delay: 5000, backoff: true, maxDelay: 0 };
    expect(computeRetryDelay(base, 3)).toBe(40000);
    expect(computeRetryDelay(base, 12)).toBe(5000 * 4096);
    expect(computeRetryDelay(base, 30)).toBe(NO_LIMIT_DELAY_MS);
  });

  test('gives up after maxAttempts retries of the same page', async () => {
    const { deps, retry } = setup({ maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      await retry.onMainFrameCompleted(1, URL, 504);
      expect(retry.hasPendingRetry(1)).toBe(true);
      await jest.advanceTimersByTimeAsync(10000);
    }
    expect(deps.reloadTab).toHaveBeenCalledTimes(2);
    await retry.onMainFrameCompleted(1, URL, 504);
    expect(retry.hasPendingRetry(1)).toBe(false);
  });

  test('unlimited by default', async () => {
    const { retry } = setup();
    for (let i = 0; i < 30; i++) {
      await retry.onMainFrameCompleted(1, URL, 504);
      expect(retry.hasPendingRetry(1)).toBe(true);
      await jest.advanceTimersByTimeAsync(10000);
    }
  });
});

describe('retry info', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('reports status, attempt and next time until the page loads fine', async () => {
    const { retry } = setup({ maxAttempts: 5 });
    expect(retry.isRetrying(1)).toBe(false);
    expect(retry.getRetryInfo(1)).toBeNull();

    const before = Date.now();
    await retry.onMainFrameCompleted(1, URL, 504);
    const info = retry.getRetryInfo(1)!;
    expect(info).toMatchObject({ statusCode: 504, attempt: 1, maxAttempts: 5 });
    expect(info.nextAt!).toBeGreaterThanOrEqual(before + 10000);

    // the retry itself is loading: still retrying, but no next time yet
    await jest.advanceTimersByTimeAsync(10000);
    expect(retry.isRetrying(1)).toBe(true);
    expect(retry.hasPendingRetry(1)).toBe(false);
    expect(retry.getRetryInfo(1)!.nextAt).toBeNull();

    await retry.onMainFrameCompleted(1, URL, 200); // success
    expect(retry.isRetrying(1)).toBe(false);
  });
});
