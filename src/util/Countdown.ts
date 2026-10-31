export const COUNTDOWN_BADGE_COLOR = '#1b7f3b';
export const PAUSED_BADGE_COLOR = '#b45f06';
export const BADGE_TEXT_COLOR = '#ffffff';
export const PAUSED_BADGE_TEXT = 'II';
export const RETRY_BADGE_TEXT = 'R';
export const COUNTDOWN_TICK_MS = 1000;

/**
 * Compact badge text for the time left until the next reload (max 4 chars).
 * Always rounds up, so the badge never shows "0" before the reload happens:
 *   up to 120s -> "119s", then whole minutes up to 60m -> "4m", then whole
 *   hours -> "2h" (capped at "99h+").
 */
export const formatCountdown = (remainingMs: number): string => {
  if (remainingMs <= 0) {
    return '0s';
  }
  if (remainingMs <= 120000) {
    return `${Math.ceil(remainingMs / 1000)}s`;
  }
  if (remainingMs <= 3600000) {
    return `${Math.ceil(remainingMs / 60000)}m`;
  }
  const hours = Math.ceil(remainingMs / 3600000);
  return hours > 99 ? '99h+' : `${hours}h`;
};

/** Human readable duration for tooltips: "1 min 30 s", "2 h 5 min", "45 s". */
export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (seconds || parts.length === 0) {
    // seconds are noise once the duration is in hours
    if (!hours) parts.push(`${seconds} s`);
  }
  return parts.join(' ');
};

export type TabIndicatorState =
  | { kind: 'off'; allTabsOff?: boolean }
  | { kind: 'running'; intervalMs: number; remainingMs: number | null }
  | { kind: 'paused' }
  | { kind: 'retrying' };

export type TabIndicator = {
  badge: string;
  title: string;
  color: string;
};

/** Badge text, badge colour and tooltip for one tab. */
export const describeTab = (state: TabIndicatorState): TabIndicator => {
  switch (state.kind) {
    case 'running':
      return {
        badge:
          state.remainingMs === null ? '' : formatCountdown(state.remainingMs),
        title:
          `AutoReload: reloading every ${formatDuration(state.intervalMs)}` +
          (state.remainingMs === null
            ? ''
            : ` \u2014 next in ${formatDuration(state.remainingMs)}`),
        color: COUNTDOWN_BADGE_COLOR,
      };
    case 'paused':
      return {
        badge: PAUSED_BADGE_TEXT,
        title: "AutoReload: paused (you're away)",
        color: PAUSED_BADGE_COLOR,
      };
    case 'retrying':
      return {
        badge: RETRY_BADGE_TEXT,
        title: 'AutoReload: the page returned an error, retrying',
        color: PAUSED_BADGE_COLOR,
      };
    default:
      return {
        badge: '',
        title: state.allTabsOff
          ? 'AutoReload is switched off for all tabs'
          : 'AutoReload: off for this tab',
        color: '',
      };
  }
};

export type CountdownTickerDeps = {
  onTick: () => void;
  onStop: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: any) => void;
};

/** One shared ticker; runs only while the setting is on and a tab is enabled. */
export default class CountdownTicker {
  private handle: unknown = null;
  private running = false;

  constructor(private deps: CountdownTickerDeps) {}

  isRunning() {
    return this.running;
  }

  sync(settingOn: boolean, enabledTabs: number) {
    const shouldRun = settingOn && enabledTabs > 0;

    if (shouldRun && !this.running) {
      this.running = true;
      this.handle = this.deps.setInterval(this.deps.onTick, COUNTDOWN_TICK_MS);
      this.deps.onTick();
    } else if (shouldRun) {
      // a tab was (re)enabled or changed: show it without waiting a second
      this.deps.onTick();
    } else if (!shouldRun && this.running) {
      this.deps.clearInterval(this.handle);
      this.handle = null;
      this.running = false;
      this.deps.onStop();
    }
  }
}
