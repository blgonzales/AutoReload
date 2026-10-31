import { getLogger } from '../common';

// Firefox reports these when a load is cancelled (user navigated away,
// stopped the page), which is not the site failing
const IGNORED_ERRORS = ['NS_BINDING_ABORTED', 'NS_ERROR_ABORT'];

export const BADGE_COLOR = '#c0392b';

export type Failure = { statusCode: number } | { error: string };

export type TabIndicator = { text: string; title: string };

export type RecoveryDeps = {
  // error retry is switched on, so failures are being tracked at all
  isTracking: () => Promise<boolean>;
  // the user wants a notification and Firefox allows it
  canNotify: () => Promise<boolean>;
  notify: (id: string, title: string, message: string) => Promise<void>;
  // per-tab toolbar hint; null removes it
  setIndicator: (
    tabId: number,
    indicator: TabIndicator | null
  ) => Promise<void>;
  // private-window tab: the OS keeps notifications in its history
  isPrivate: (tabId: number) => Promise<boolean>;
  focusTab: (tabId: number) => Promise<void>;
  clearNotification: (id: string) => Promise<void>;
  now?: () => number;
  formatTime?: (timestamp: number) => string;
};

type FailingPage = {
  url: string;
  attempts: number; // failed loads so far
  first: Failure;
  firstAt: number;
  last: Failure;
  lastAt: number;
  nextAt: number | null; // when the next retry is due
  gaveUp: boolean;
  maxAttempts: number | null;
  indicator?: TabIndicator;
};

/**
 * What is known about a failing tab; the single source for the tab hint, so
 * any other status display can render from the same data.
 * state: 'retrying' = a retry is scheduled (nextAt), 'waiting' = no retry of
 * ours is scheduled (network error, the next reload comes from the tab's own
 * interval), 'gave-up' = the retry cap was reached.
 */
export type RecoveryStatus = {
  state: 'retrying' | 'waiting' | 'gave-up';
  reason: { status: number } | { network: 'unreachable'; error: string };
  url: string;
  since: number;
  attempt: number;
  maxAttempts: number | null;
  nextAt: number | null;
};

/** origin + path: a retry may differ in hash (or a cache-busting query). */
export const locationKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

export const formatAgo = (ms: number): string => {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) {
    return 'less than a minute ago';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''} ago`;
};

const formatDelay = (ms: number): string =>
  ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;

const defaultFormatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

/** Badge text and tooltip for a status; delay = ms until the next retry. */
export const indicatorFromStatus = (
  status: RecoveryStatus,
  host: string,
  delay: number | null
): TabIndicator => {
  const what =
    'status' in status.reason
      ? `returned ${status.reason.status}`
      : 'is unreachable';
  let next = `waiting for it to load again (attempt ${status.attempt})`;
  if (status.state === 'gave-up') {
    next = `gave up retrying (attempt ${status.attempt})`;
  } else if (status.state === 'retrying' && delay !== null) {
    next = `retrying in ${formatDelay(delay)} (attempt ${status.attempt})`;
  }
  return {
    text: 'status' in status.reason ? String(status.reason.status) : 'ERR',
    title: `AutoReload: ${host} ${what} — ${next}`,
  };
};

const describe = (failure: Failure) =>
  'statusCode' in failure ? `HTTP ${failure.statusCode}` : 'unreachable';

/**
 * Remembers, per tab, the page that is failing (a configured HTTP error or a
 * network error) and tells the user once when that same page loads again with
 * a 2xx/3xx status. The state is dropped when the tab moves on or closes.
 */
export default class RecoveryNotifier {
  private failing = new Map<number, FailingPage>();

  private notificationTabs = new Map<string, number>();

  private deps: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  isFailing(tabId: number) {
    return this.failing.has(tabId);
  }

  getAttempts(tabId: number) {
    return this.failing.get(tabId)?.attempts ?? 0;
  }

  /**
   * A top-level load failed. `delay` is the time until the next retry, null
   * when AutoReload gave up, undefined when it doesn't schedule retries itself
   * (network errors).
   */
  onFailure(
    tabId: number,
    url: string,
    failure: Failure,
    delay?: number | null,
    maxAttempts: number | null = null
  ) {
    if (tabId < 0) {
      return;
    }
    const at = this.deps.now ? this.deps.now() : Date.now();
    const previous = this.failing.get(tabId);
    const sameCause =
      previous && locationKey(previous.url) === locationKey(url);
    const entry: FailingPage = {
      url,
      attempts: sameCause && previous ? previous.attempts + 1 : 1,
      first: sameCause && previous ? previous.first : failure,
      firstAt: sameCause && previous ? previous.firstAt : at,
      last: failure,
      lastAt: at,
      nextAt: typeof delay === 'number' ? at + delay : null,
      gaveUp: delay === null,
      maxAttempts,
    };
    this.failing.set(tabId, entry);
    entry.indicator = this.indicatorFor(tabId);

    this.deps
      .setIndicator(tabId, entry.indicator)
      .catch((error) => getLogger().debug('Could not set tab hint', error));
  }

  /** A main-frame network error (connection refused, DNS failure, ...). */
  async onNetworkError(tabId: number, url: string, error: string) {
    if (tabId < 0 || IGNORED_ERRORS.includes(error)) {
      return;
    }
    if (!(await this.deps.isTracking())) {
      return;
    }
    this.onFailure(tabId, url, { error });
  }

  /** A top-level navigation started; leaving the failing page ends tracking. */
  onStarted(tabId: number, url: string) {
    const entry = this.failing.get(tabId);
    if (entry && locationKey(entry.url) !== locationKey(url)) {
      this.forget(tabId);
    }
  }

  /**
   * A top-level load finished with `statusCode`. A 2xx/3xx on the failing page
   * is the recovery; any load of another page just ends tracking.
   */
  async onSuccess(tabId: number, url: string, statusCode: number) {
    const entry = this.failing.get(tabId);
    if (!entry || statusCode < 200 || statusCode >= 400) {
      return;
    }
    // drop the state first so a second event for the same load can't repeat it
    this.failing.delete(tabId);
    await this.deps
      .setIndicator(tabId, null)
      .catch((error) => getLogger().debug('Could not clear tab hint', error));

    if (locationKey(entry.url) !== locationKey(url)) {
      return;
    }

    try {
      if (!(await this.deps.isTracking())) {
        return;
      }
      if (!(await this.deps.canNotify())) {
        getLogger().debug(`Tab ${tabId} is back, notifications not available`);
        return;
      }
      // unknown counts as private: better generic than leaking a host
      const priv = await this.deps.isPrivate(tabId).catch(() => true);
      const id = `autoreload-recovery-${tabId}`;
      this.notificationTabs.set(id, tabId);
      await (priv
        ? this.deps.notify(
            id,
            'A private tab is back',
            `The page loaded successfully after ${this.attemptsText(entry)}.`
          )
        : this.deps.notify(
            id,
            `${hostOf(url)} is back`,
            this.messageFor(entry)
          ));
    } catch (error) {
      getLogger().error('Could not show the recovery notification', error);
    }
  }

  async onNotificationClicked(id: string) {
    const tabId = this.notificationTabs.get(id);
    if (tabId === undefined) {
      return;
    }
    this.notificationTabs.delete(id);
    try {
      await this.deps.focusTab(tabId);
    } catch (error) {
      // the tab may be gone
      getLogger().debug(`Could not focus tab ${tabId}`, error);
    }
    await this.deps.clearNotification(id).catch(() => undefined);
  }

  /** Tab navigated elsewhere or closed. */
  forget(tabId: number) {
    if (this.failing.delete(tabId)) {
      this.deps
        .setIndicator(tabId, null)
        .catch((error) => getLogger().debug('Could not clear tab hint', error));
    }
  }

  forgetAll() {
    for (const tabId of Array.from(this.failing.keys())) {
      this.forget(tabId);
    }
  }

  private attemptsText(entry: FailingPage): string {
    return `${entry.attempts} failed ${
      entry.attempts === 1 ? 'attempt' : 'attempts'
    }`;
  }

  private messageFor(entry: FailingPage): string {
    const now = this.deps.now ? this.deps.now() : Date.now();
    const format = this.deps.formatTime ?? defaultFormatTime;
    const attempts = this.attemptsText(entry);
    const first =
      'statusCode' in entry.first
        ? `first error ${describe(entry.first)}`
        : 'site was unreachable';
    return `Loaded successfully after ${attempts} (${first} at ${format(
      entry.firstAt
    )}, ${formatAgo(now - entry.firstAt)}).`;
  }

  /** Pure query: the failing state of a tab, or null when it isn't failing. */
  getRecoveryStatus(tabId: number): RecoveryStatus | null {
    const entry = this.failing.get(tabId);
    if (!entry) {
      return null;
    }
    const last = entry.last;
    let state: RecoveryStatus['state'] = 'waiting';
    if (entry.gaveUp) {
      state = 'gave-up';
    } else if (entry.nextAt !== null) {
      state = 'retrying';
    }
    return {
      state,
      reason:
        'statusCode' in last
          ? { status: last.statusCode }
          : { network: 'unreachable', error: last.error },
      url: entry.url,
      since: entry.firstAt,
      attempt: entry.attempts,
      maxAttempts: entry.maxAttempts,
      nextAt: entry.nextAt,
    };
  }

  // badge text and tooltip, derived only from getRecoveryStatus
  private indicatorFor(tabId: number): TabIndicator {
    const entry = this.failing.get(tabId) as FailingPage;
    const status = this.getRecoveryStatus(tabId) as RecoveryStatus;
    return indicatorFromStatus(
      status,
      hostOf(status.url),
      entry.nextAt !== null ? entry.nextAt - entry.lastAt : null
    );
  }

  /** Re-applies the hint; Firefox resets per-tab values when a tab navigates. */
  async refreshIndicator(tabId: number) {
    const indicator = this.failing.get(tabId)?.indicator;
    if (indicator) {
      await this.deps.setIndicator(tabId, indicator);
    }
  }
}
