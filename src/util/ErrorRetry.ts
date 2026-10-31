import { getLogger } from '../common';

const SAFE_METHODS = ['GET', 'HEAD'];

// Retry-After values above this are ignored in favour of the normal schedule
export const MAX_RETRY_AFTER_MS = 3600000;

// With "no limit" the backoff keeps doubling but stops growing at one day
// (also keeps the delay far below the largest value setTimeout accepts)
export const NO_LIMIT_DELAY_MS = 24 * 3600000;

export type RetryOptions = {
  enabled: boolean;
  statusCodes: number[];
  delay: number; // first retry delay, milliseconds
  backoff: boolean; // double the delay after every failed retry
  maxDelay: number; // backoff ceiling, milliseconds; 0 = no limit (see NO_LIMIT_DELAY_MS)
  maxAttempts?: number; // retries per failing page before giving up; 0 or unset = unlimited
};

export type ErrorRetryDeps = {
  getOptions: () => Promise<RetryOptions>;
  getTabUrl: (tabId: number) => Promise<string | undefined>;
  reloadTab: (tabId: number) => Promise<void>;
  now?: () => number;
  // a configured error status was seen; delay is null when retrying gave up
  onFailure?: (failure: {
    tabId: number;
    url: string;
    statusCode: number;
    attempt: number; // failed loads of this url so far, this one included
    delay: number | null; // ms until the next retry
    maxAttempts: number | null; // retry cap in effect, null = unlimited
  }) => void;
};

export type RetryInfo = {
  statusCode: number; // HTTP status that caused the retry
  attempt: number; // retry number that is scheduled or in flight (1 = first)
  maxAttempts: number; // 0 = unlimited
  nextAt: number | null; // when the next reload is due; null while it is loading
};

type PendingRetry = {
  url: string;
  statusCode: number;
  maxAttempts: number;
  nextAt: number | null;
  attempt: number; // retries already made for this url
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Delay before retry number `attempt` (0 = first retry). With backoff the
 * delay doubles each time up to maxDelay. A server-sent Retry-After wins when
 * it asks for longer (but never beyond MAX_RETRY_AFTER_MS).
 */
export const computeRetryDelay = (
  options: Pick<RetryOptions, 'delay' | 'backoff' | 'maxDelay'>,
  attempt: number,
  retryAfterMs?: number
): number => {
  let delay = options.delay;
  if (options.backoff) {
    const ceiling =
      options.maxDelay > 0
        ? Math.max(options.delay, options.maxDelay)
        : Math.max(options.delay, NO_LIMIT_DELAY_MS);
    delay = Math.min(options.delay * 2 ** Math.min(attempt, 30), ceiling);
  }
  if (
    retryAfterMs !== undefined &&
    retryAfterMs > delay &&
    retryAfterMs <= MAX_RETRY_AFTER_MS
  ) {
    delay = retryAfterMs;
  }
  return delay;
};

/** Parses a Retry-After header (delay-seconds or HTTP-date) into ms. */
export const parseRetryAfter = (
  value: string | undefined,
  now: number = Date.now()
): number | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
};

/**
 * Parses user-entered status codes: numbers and ranges separated by commas
 * or spaces, e.g. "418, 520-527". Only 400-599 are accepted.
 */
export const parseStatusCodes = (
  input: string
): { codes: number[]; invalid: string[] } => {
  const codes = new Set<number>();
  const invalid: string[] = [];

  for (const token of input.split(/[\s,;]+/).filter(Boolean)) {
    const range = token.match(/^(\d{3})-(\d{3})$/);
    const single = token.match(/^(\d{3})$/);
    const from = Number(range ? range[1] : single?.[1]);
    const to = Number(range ? range[2] : single?.[1]);

    if (!(range || single) || from < 400 || to > 599 || from > to) {
      invalid.push(token);
      continue;
    }
    for (let code = from; code <= to; code++) {
      codes.add(code);
    }
  }

  return { codes: Array.from(codes).sort((a, b) => a - b), invalid };
};

/**
 * Schedules a reload for tabs whose top-level document came back with one of
 * the configured HTTP error codes for a GET/HEAD request. Repeated failures of
 * the same URL back off. A pending retry is dropped when the tab finishes
 * loading anything else, navigates away, or is closed.
 */
export default class ErrorRetry {
  private pending = new Map<number, PendingRetry>();

  private deps: ErrorRetryDeps;

  constructor(deps: ErrorRetryDeps) {
    this.deps = deps;
  }

  hasPendingRetry(tabId: number) {
    return this.pending.get(tabId)?.timer != null;
  }

  /** True from the first failure until the page loads fine, the cap is hit or the tab is forgotten. */
  isRetrying(tabId: number) {
    return this.pending.has(tabId);
  }

  getRetryInfo(tabId: number): RetryInfo | null {
    const entry = this.pending.get(tabId);
    if (!entry) {
      return null;
    }
    return {
      statusCode: entry.statusCode,
      attempt: entry.attempt,
      maxAttempts: entry.maxAttempts,
      nextAt: entry.timer !== null ? entry.nextAt : null,
    };
  }

  getAttempt(tabId: number) {
    return this.pending.get(tabId)?.attempt ?? 0;
  }

  async onMainFrameCompleted(
    tabId: number,
    url: string,
    statusCode: number,
    method: string = 'GET',
    retryAfter?: string
  ) {
    if (tabId < 0) {
      return;
    }

    // only replay safe navigations; reloading a failed POST would resubmit it
    if (!SAFE_METHODS.includes(method.toUpperCase())) {
      this.forget(tabId);
      return;
    }

    const options = await this.deps.getOptions();
    if (!options.enabled || !options.statusCodes.includes(statusCode)) {
      this.forget(tabId);
      return;
    }

    const previous = this.pending.get(tabId);
    const attempt = previous && previous.url === url ? previous.attempt : 0;
    this.forget(tabId);

    if (options.maxAttempts && attempt >= options.maxAttempts) {
      getLogger().debug(
        `Tab ${tabId} still returns ${statusCode} for ${url} after ${attempt} retries, giving up`
      );
      this.deps.onFailure?.({
        tabId,
        url,
        statusCode,
        attempt: attempt + 1,
        delay: null,
        maxAttempts: options.maxAttempts || null,
      });
      return;
    }

    const now = this.deps.now ? this.deps.now() : Date.now();
    const delay = computeRetryDelay(
      options,
      attempt,
      parseRetryAfter(retryAfter, now)
    );

    getLogger().debug(
      `Tab ${tabId} returned ${statusCode} for ${url}, retry ${
        attempt + 1
      } in ${delay / 1000} seconds`
    );

    this.deps.onFailure?.({
      tabId,
      url,
      statusCode,
      attempt: attempt + 1,
      delay,
      maxAttempts: options.maxAttempts || null,
    });

    const entry: PendingRetry = {
      url,
      statusCode,
      maxAttempts: options.maxAttempts ?? 0,
      nextAt: now + delay,
      attempt: attempt + 1,
      timer: null,
    };
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      await this.retry(tabId, url);
    }, delay);
    this.pending.set(tabId, entry);
  }

  /** Drops the pending retry and the attempt count for a tab. */
  forget(tabId: number) {
    const pendingRetry = this.pending.get(tabId);
    if (!pendingRetry) {
      return;
    }

    if (pendingRetry.timer !== null) {
      clearTimeout(pendingRetry.timer);
    }
    this.pending.delete(tabId);
  }

  forgetAll() {
    for (const tabId of Array.from(this.pending.keys())) {
      this.forget(tabId);
    }
  }

  private async retry(tabId: number, url: string) {
    try {
      const currentUrl = await this.deps.getTabUrl(tabId);
      if (currentUrl !== undefined && currentUrl !== url) {
        getLogger().debug(
          `Tab ${tabId} moved on to ${currentUrl}, skipping error retry`
        );
        this.forget(tabId);
        return;
      }

      getLogger().debug(`Retrying tab ${tabId}`);
      await this.deps.reloadTab(tabId);
    } catch (error) {
      // the tab may have been closed in the meantime
      getLogger().error(`Failed to retry tab ${tabId}`, error);
      this.forget(tabId);
    }
  }
}

type SeenNavigation = { url: string; method: string };

/**
 * Tracks top-level navigations whose webRequest completion was never
 * reported. That happens when a service worker answers the navigation
 * (offline/caching add-ons, PWAs): webRequest sees onBeforeRequest for the
 * tab but no onCompleted/onErrorOccurred, so the status code has to be read
 * from the page itself (Navigation Timing responseStatus) instead.
 */
export class UnreportedNavigations {
  private started = new Map<number, SeenNavigation>();

  onStarted(tabId: number, url: string, method: string) {
    if (tabId >= 0) {
      this.started.set(tabId, { url, method });
    }
  }

  // onCompleted or onErrorOccurred arrived: webRequest reported this one
  onReported(tabId: number) {
    this.started.delete(tabId);
  }

  /** Called when the tab finished loading; returns the unreported navigation. */
  takeUnreported(tabId: number): SeenNavigation | undefined {
    const navigation = this.started.get(tabId);
    this.started.delete(tabId);
    return navigation;
  }

  forget(tabId: number) {
    this.started.delete(tabId);
  }
}

// runs in the page: HTTP status of the current document (0 when unknown)
export const READ_NAVIGATION_STATUS = `(() => {
  const entry = performance.getEntriesByType('navigation')[0];
  return entry && entry.responseStatus ? entry.responseStatus : 0;
})();`;
