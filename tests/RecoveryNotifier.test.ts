import ErrorRetry, { RetryOptions } from '../src/util/ErrorRetry';
import RecoveryNotifier, {
  RecoveryDeps,
  formatAgo,
  locationKey,
} from '../src/util/RecoveryNotifier';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

const URL = 'https://example.com/status';
const MINUTE = 60000;

type Mocks = {
  isTracking: jest.Mock;
  canNotify: jest.Mock;
  notify: jest.Mock;
  setIndicator: jest.Mock;
  isPrivate: jest.Mock;
  focusTab: jest.Mock;
  clearNotification: jest.Mock;
};

const setup = (overrides: Partial<RecoveryDeps> = {}) => {
  let clock = Date.UTC(2026, 9, 31, 19, 31);
  const deps = {
    isTracking: jest.fn().mockResolvedValue(true),
    canNotify: jest.fn().mockResolvedValue(true),
    notify: jest.fn().mockResolvedValue(undefined),
    setIndicator: jest.fn().mockResolvedValue(undefined),
    isPrivate: jest.fn().mockResolvedValue(false),
    focusTab: jest.fn().mockResolvedValue(undefined),
    clearNotification: jest.fn().mockResolvedValue(undefined),
    now: () => clock,
    formatTime: () => '19:31',
    ...overrides,
  } as unknown as Mocks & RecoveryDeps;
  return {
    deps,
    notifier: new RecoveryNotifier(deps),
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe('RecoveryNotifier', () => {
  test('fail, fail, success sends exactly one notification with the counts', async () => {
    const { deps, notifier, advance } = setup();

    notifier.onFailure(1, URL, { statusCode: 504 }, 30000);
    advance(6 * MINUTE);
    notifier.onFailure(1, URL, { statusCode: 504 }, 30000);
    advance(6 * MINUTE);
    await notifier.onSuccess(1, URL, 200);
    await notifier.onSuccess(1, URL, 200);

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(
      'autoreload-recovery-1',
      'example.com is back',
      'Loaded successfully after 2 failed attempts (first error HTTP 504 at 19:31, 12 min ago).'
    );
    expect(notifier.isFailing(1)).toBe(false);
  });

  test('a private tab gets generic text without host, url or times', async () => {
    const { deps, notifier } = setup({
      isPrivate: jest.fn().mockResolvedValue(true),
    });
    notifier.onFailure(1, 'https://secret.example/a?q=1', { statusCode: 504 });
    notifier.onFailure(1, 'https://secret.example/a?q=1', { statusCode: 504 });
    await notifier.onSuccess(1, 'https://secret.example/a?q=1', 200);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(
      'autoreload-recovery-1',
      'A private tab is back',
      'The page loaded successfully after 2 failed attempts.'
    );
    const text = JSON.stringify(deps.notify.mock.calls[0]);
    expect(text).not.toMatch(/secret|example|504|19:31|ago/);
    // clicking it still focuses the tab
    await notifier.onNotificationClicked('autoreload-recovery-1');
    expect(deps.focusTab).toHaveBeenCalledWith(1);
  });

  test('an unknown private state is treated as private', async () => {
    const { deps, notifier } = setup({
      isPrivate: jest.fn().mockRejectedValue(new Error('gone')),
    });
    notifier.onFailure(1, URL, { statusCode: 504 });
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify.mock.calls[0][1]).toBe('A private tab is back');
  });

  test('a normal tab keeps the host in the notification', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 });
    await notifier.onSuccess(1, URL, 200);
    expect(deps.isPrivate).toHaveBeenCalledWith(1);
    expect(deps.notify.mock.calls[0][1]).toBe('example.com is back');
  });

  test('says "attempt" for a single failure', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 503 }, 1000);
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify.mock.calls[0][2]).toBe(
      'Loaded successfully after 1 failed attempt (first error HTTP 503 at 19:31, less than a minute ago).'
    );
  });

  test('a 3xx counts as loading again', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 502 }, 1000);
    await notifier.onSuccess(1, URL, 304);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  test('success without a prior failure sends nothing', async () => {
    const { deps, notifier } = setup();
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test('another error status keeps the page failing without notifying', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    await notifier.onSuccess(1, URL, 404);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(notifier.isFailing(1)).toBe(true);
  });

  test('the same page with another hash or query still counts', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, `${URL}?a=1#x`, { statusCode: 504 }, 1000);
    notifier.onStarted(1, `${URL}?a=2#y`);
    await notifier.onSuccess(1, `${URL}?a=2#y`, 200);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(locationKey(`${URL}?a=2#y`)).toBe(URL);
  });

  test('navigating elsewhere clears the state silently', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    notifier.onStarted(1, 'https://example.com/other');
    expect(notifier.isFailing(1)).toBe(false);
    await notifier.onSuccess(1, 'https://example.com/other', 200);
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test('a successful load of a different page does not notify', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    await notifier.onSuccess(1, 'https://example.com/login', 200);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(notifier.isFailing(1)).toBe(false);
  });

  test('closing the tab clears the state', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    notifier.forget(1);
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.setIndicator).toHaveBeenLastCalledWith(1, null);
  });

  test('tabs are tracked separately', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    notifier.onFailure(2, URL, { statusCode: 504 }, 1000);
    await notifier.onSuccess(2, URL, 200);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(notifier.isFailing(1)).toBe(true);
  });

  test('a network error counts as a failure', async () => {
    const { deps, notifier, advance } = setup();
    await notifier.onNetworkError(1, URL, 'NS_ERROR_CONNECTION_REFUSED');
    advance(3 * MINUTE);
    await notifier.onNetworkError(1, URL, 'NS_ERROR_NET_TIMEOUT');
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify.mock.calls[0][2]).toBe(
      'Loaded successfully after 2 failed attempts (site was unreachable at 19:31, 3 min ago).'
    );
  });

  test('cancelled loads are not failures', async () => {
    const { notifier } = setup();
    await notifier.onNetworkError(1, URL, 'NS_BINDING_ABORTED');
    await notifier.onNetworkError(1, URL, 'NS_ERROR_ABORT');
    expect(notifier.isFailing(1)).toBe(false);
  });

  test('network errors are ignored while error retry is off', async () => {
    const { notifier } = setup({
      isTracking: jest.fn().mockResolvedValue(false),
    });
    await notifier.onNetworkError(1, URL, 'NS_ERROR_CONNECTION_REFUSED');
    expect(notifier.isFailing(1)).toBe(false);
  });

  test('without the notifications permission only the tab hint is used', async () => {
    const { deps, notifier } = setup({
      canNotify: jest.fn().mockResolvedValue(false),
    });
    notifier.onFailure(1, URL, { statusCode: 504 }, 30000);
    expect(deps.setIndicator).toHaveBeenCalledWith(1, {
      text: '504',
      title:
        'AutoReload: example.com returned 504 — retrying in 30 s (attempt 1)',
    });
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.setIndicator).toHaveBeenLastCalledWith(1, null);
  });

  test('no notification when error retry was switched off meanwhile', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    deps.isTracking.mockResolvedValue(false);
    await notifier.onSuccess(1, URL, 200);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test('a failing notify call does not throw', async () => {
    const { notifier } = setup({
      notify: jest.fn().mockRejectedValue(new Error('denied')),
    });
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    await expect(notifier.onSuccess(1, URL, 200)).resolves.toBeUndefined();
  });

  test('tab hint shows the attempt, the next retry and giving up', () => {
    const { deps, notifier } = setup();
    notifier.onFailure(1, URL, { statusCode: 504 }, 30000);
    notifier.onFailure(1, URL, { statusCode: 504 }, 120000);
    notifier.onFailure(1, URL, { statusCode: 504 }, null);
    const titles = deps.setIndicator.mock.calls.map((c) => c[1].title);
    expect(titles).toEqual([
      'AutoReload: example.com returned 504 — retrying in 30 s (attempt 1)',
      'AutoReload: example.com returned 504 — retrying in 2 min (attempt 2)',
      'AutoReload: example.com returned 504 — gave up retrying (attempt 3)',
    ]);
  });

  test('network error hint uses ERR', async () => {
    const { deps, notifier } = setup();
    await notifier.onNetworkError(1, URL, 'NS_ERROR_UNKNOWN_HOST');
    expect(deps.setIndicator).toHaveBeenCalledWith(1, {
      text: 'ERR',
      title:
        'AutoReload: example.com is unreachable — waiting for it to load again (attempt 1)',
    });
  });

  test('getRecoveryStatus describes the failing tab', async () => {
    const { notifier, advance } = setup();
    expect(notifier.getRecoveryStatus(1)).toBeNull();
    const t0 = Date.UTC(2026, 9, 31, 19, 31);
    notifier.onFailure(1, URL, { statusCode: 504 }, 30000, 5);
    advance(60000);
    notifier.onFailure(1, URL, { statusCode: 504 }, 60000, 5);
    expect(notifier.getRecoveryStatus(1)).toEqual({
      state: 'retrying',
      reason: { status: 504 },
      url: URL,
      since: t0,
      attempt: 2,
      maxAttempts: 5,
      nextAt: t0 + 120000,
    });
    notifier.onFailure(1, URL, { statusCode: 504 }, null, 5);
    expect(notifier.getRecoveryStatus(1)?.state).toBe('gave-up');
    await notifier.onNetworkError(2, URL, 'NS_ERROR_CONNECTION_REFUSED');
    expect(notifier.getRecoveryStatus(2)).toMatchObject({
      state: 'waiting',
      reason: { network: 'unreachable', error: 'NS_ERROR_CONNECTION_REFUSED' },
      nextAt: null,
    });
    await notifier.onSuccess(1, URL, 200);
    expect(notifier.getRecoveryStatus(1)).toBeNull();
  });

  test('refreshIndicator re-applies the hint only while failing', async () => {
    const { deps, notifier } = setup();
    await notifier.refreshIndicator(1);
    expect(deps.setIndicator).not.toHaveBeenCalled();
    notifier.onFailure(1, URL, { statusCode: 504 }, 1000);
    await notifier.refreshIndicator(1);
    expect(deps.setIndicator).toHaveBeenCalledTimes(2);
  });

  test('clicking the notification focuses its tab and clears it once', async () => {
    const { deps, notifier } = setup();
    notifier.onFailure(7, URL, { statusCode: 504 }, 1000);
    await notifier.onSuccess(7, URL, 200);

    await notifier.onNotificationClicked('autoreload-recovery-7');
    expect(deps.focusTab).toHaveBeenCalledWith(7);
    expect(deps.clearNotification).toHaveBeenCalledWith(
      'autoreload-recovery-7'
    );

    await notifier.onNotificationClicked('autoreload-recovery-7');
    await notifier.onNotificationClicked('something-else');
    expect(deps.focusTab).toHaveBeenCalledTimes(1);
  });

  test('clicking still clears the notification when the tab is gone', async () => {
    const { deps, notifier } = setup({
      focusTab: jest.fn().mockRejectedValue(new Error('no tab')),
    });
    notifier.onFailure(7, URL, { statusCode: 504 }, 1000);
    await notifier.onSuccess(7, URL, 200);
    await notifier.onNotificationClicked('autoreload-recovery-7');
    expect(deps.clearNotification).toHaveBeenCalled();
  });

  test('formatAgo', () => {
    expect(formatAgo(10000)).toBe('less than a minute ago');
    expect(formatAgo(12 * MINUTE)).toBe('12 min ago');
    expect(formatAgo(60 * MINUTE)).toBe('1 h ago');
    expect(formatAgo(125 * MINUTE)).toBe('2 h 5 min ago');
  });
});

describe('ErrorRetry + RecoveryNotifier together', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const OPTIONS: RetryOptions = {
    enabled: true,
    statusCodes: [504],
    delay: 5000,
    backoff: false,
    maxDelay: 60000,
  };

  const wire = (options: Partial<RetryOptions> = {}) => {
    const { deps, notifier } = setup();
    const retry = new ErrorRetry({
      getOptions: jest.fn().mockResolvedValue({ ...OPTIONS, ...options }),
      getTabUrl: jest.fn().mockResolvedValue(URL),
      reloadTab: jest.fn().mockResolvedValue(undefined),
      onFailure: ({ tabId, url, statusCode, delay, maxAttempts }) =>
        notifier.onFailure(tabId, url, { statusCode }, delay, maxAttempts),
    });
    // what app.ts does for a webRequest.onCompleted of a main frame
    const completed = async (status: number) => {
      notifier.onStarted(1, URL);
      await retry.onMainFrameCompleted(1, URL, status);
      await notifier.onSuccess(1, URL, status);
    };
    return { deps, notifier, retry, completed };
  };

  test('504, 504, 200 gives one notification and a tab hint in between', async () => {
    const { deps, notifier, completed } = wire();

    await completed(504);
    await jest.advanceTimersByTimeAsync(5000);
    await completed(504);
    expect(notifier.getAttempts(1)).toBe(2);
    expect(deps.setIndicator).toHaveBeenLastCalledWith(1, {
      text: '504',
      title:
        'AutoReload: example.com returned 504 — retrying in 5 s (attempt 2)',
    });
    await jest.advanceTimersByTimeAsync(5000);
    await completed(200);

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][2]).toContain('after 2 failed attempts');
    expect(deps.setIndicator).toHaveBeenLastCalledWith(1, null);
  });

  test('a status that is not configured never starts tracking', async () => {
    const { deps, completed } = wire();
    await completed(500);
    await completed(200);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test('giving up after the retry cap still counts the last failure', async () => {
    const { deps, notifier, completed } = wire({ maxAttempts: 1 });
    await completed(504);
    await jest.advanceTimersByTimeAsync(5000);
    await completed(504);
    expect(notifier.getAttempts(1)).toBe(2);
    expect(deps.setIndicator).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        title: expect.stringContaining('gave up retrying'),
      })
    );
  });

  test('service worker path: status read from the page feeds both', async () => {
    const { deps, notifier, retry } = wire();
    // what handleTabComplete does after reading the page's responseStatus
    const fromPage = async (status: number) => {
      await retry.onMainFrameCompleted(1, URL, status, 'GET');
      await notifier.onSuccess(1, URL, status);
    };
    await fromPage(504);
    await fromPage(504);
    await fromPage(200);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][2]).toContain('after 2 failed attempts');
  });
});
