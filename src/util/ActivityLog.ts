import {
  Interval,
  SettingsType,
  convertIntervalToTimeoutInterval,
} from '../common';

/**
 * In-memory activity log.
 *
 * Lives in the background page only: nothing is persisted or sent anywhere,
 * and it starts empty again whenever the browser or the add-on restarts.
 *
 * Any feature can add its own events with one line:
 *
 *   activityLog.record('error-retry', 'Retrying after HTTP 503', { tabId });
 *
 * `kind` is a free-form short identifier (see KIND_LABELS for the built-in
 * ones; unknown kinds are shown as-is). `message` is one human-readable line.
 */

export const DEFAULT_CAP = 500;

export type ActivityContext = {
  tabId?: number;
  // Optional: when omitted and a tab info provider is set, they are looked up.
  tabTitle?: string;
  url?: string;
  // Extra text shown under the message (e.g. old -> new values).
  details?: string;
};

export type ActivityEntry = {
  id: number;
  time: number;
  kind: string;
  tabId?: number;
  tabTitle?: string;
  host?: string;
  // True when the tab is in a private window (title/address are never kept).
  private?: boolean;
  // Full URL kept in memory only; the log page shows the host unless the
  // user ticks "Show full URLs".
  url?: string;
  message: string;
  details?: string;
};

// `private: true` means the tab is (or may be) in a private window: only the
// fact that it is private is kept, never its title or address.
export type TabInfo = { title?: string; url?: string; private?: boolean };

/** Only a tab that is explicitly not incognito exposes its title and address. */
export const tabInfoFromTab = (tab: {
  title?: string;
  url?: string;
  incognito?: boolean;
}): TabInfo =>
  tab.incognito === false
    ? { title: tab.title, url: tab.url, private: false }
    : { private: true };

export const PRIVATE_TAB_LABEL = 'Private tab';

// Anything that looks like an address, for text that may mention one.
const scrubUrls = (text: string): string =>
  text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[private address]');
export type TabInfoProvider = (
  tabId: number
) => Promise<TabInfo | null | undefined>;

export interface ActivityRecorder {
  record(kind: string, message: string, ctx?: ActivityContext): void;
}

export type ActivityLogOptions = {
  now?: () => number;
  cap?: number;
  getTabInfo?: TabInfoProvider;
};

export const KIND_LABELS: Record<string, string> = {
  startup: 'Add-on started',
  reload: 'Reload',
  'timer-started': 'Timer started',
  'timer-stopped': 'Timer stopped',
  global: 'Global on/off',
  idle: 'Idle',
  settings: 'Settings changed',
  error: 'Error',
};

export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

export const hostOf = (url?: string): string | undefined => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    // about:, moz-extension: etc. have no host; show the scheme instead
    return u.host || `${u.protocol}${u.pathname}`;
  } catch {
    return undefined;
  }
};

export class ActivityLog implements ActivityRecorder {
  private entries: ActivityEntry[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();
  private tabCache = new Map<number, TabInfo>();
  private now: () => number;
  private cap: number;
  private getTabInfo?: TabInfoProvider;
  readonly startedAt: number;

  constructor(options: ActivityLogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cap = options.cap ?? DEFAULT_CAP;
    this.getTabInfo = options.getTabInfo;
    this.startedAt = this.now();
  }

  setTabInfoProvider(provider: TabInfoProvider) {
    this.getTabInfo = provider;
  }

  getCap() {
    return this.cap;
  }

  /** Add an entry. Returns it (already stored). */
  record(
    kind: string,
    message: string,
    ctx: ActivityContext = {}
  ): ActivityEntry {
    const cached =
      ctx.tabId !== undefined ? this.tabCache.get(ctx.tabId) : undefined;
    const isPrivate = cached?.private === true;
    const title = isPrivate ? undefined : (ctx.tabTitle ?? cached?.title);
    const url = isPrivate ? undefined : (ctx.url ?? cached?.url);
    // Error text can quote an address; until the tab is known to be a normal
    // one, keep addresses out of it.
    if (ctx.tabId !== undefined && cached?.private !== false) {
      message = scrubUrls(message);
      if (ctx.details !== undefined)
        ctx = { ...ctx, details: scrubUrls(ctx.details) };
    }

    const entry: ActivityEntry = {
      id: this.nextId++,
      time: this.now(),
      kind,
      message,
    };
    if (ctx.tabId !== undefined) entry.tabId = ctx.tabId;
    if (isPrivate) {
      entry.tabTitle = PRIVATE_TAB_LABEL;
      entry.private = true;
    }
    if (title !== undefined) entry.tabTitle = title;
    if (url !== undefined) {
      entry.url = url;
      entry.host = hostOf(url);
    }
    if (ctx.details !== undefined) entry.details = ctx.details;

    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
    this.notify();

    // Fill in the tab's current title/host in the background. The entry is
    // patched in place, so callers never wait for it. A closed tab simply
    // keeps whatever was cached from earlier.
    if (ctx.tabId !== undefined && this.getTabInfo && !isPrivate) {
      this.refreshTab(ctx.tabId, entry, ctx.tabTitle === undefined);
    }
    return entry;
  }

  private async refreshTab(
    tabId: number,
    entry: ActivityEntry,
    fillTitle: boolean
  ) {
    let info: TabInfo | null | undefined;
    try {
      info = await this.getTabInfo!(tabId);
    } catch {
      // Tab gone or unreadable: a tab not known to be normal counts as private.
      if (this.tabCache.get(tabId)?.private === false) return;
      info = { private: true };
    }
    if (!info) return;
    if (info.private === true) {
      this.tabCache.set(tabId, { private: true });
      entry.private = true;
      entry.tabTitle = PRIVATE_TAB_LABEL;
      delete entry.url;
      delete entry.host;
      entry.message = scrubUrls(entry.message);
      if (entry.details !== undefined) entry.details = scrubUrls(entry.details);
      this.notify();
      return;
    }
    this.tabCache.set(tabId, {
      title: info.title,
      url: info.url,
      private: false,
    });
    if (info.title !== undefined && fillTitle) {
      entry.tabTitle = info.title;
    }
    if (info.url !== undefined && entry.url === undefined) {
      entry.url = info.url;
      entry.host = hostOf(info.url);
    }
    this.notify();
  }

  /** Oldest first. */
  getEntries(): ActivityEntry[] {
    return this.entries.slice();
  }

  clear() {
    this.entries = [];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}

export const activityLog = new ActivityLog();

// ---- formatting helpers ---------------------------------------------------

export const formatMs = (ms: number): string => {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : '']
    .filter(Boolean)
    .join(' ');
};

export const formatInterval = (interval: Interval): string =>
  formatMs(convertIntervalToTimeoutInterval(interval));

// ---- settings diff --------------------------------------------------------

type SettingDescriptor = {
  label: string;
  format: (value: any) => string;
};

const yesNo = (v: any) => (v ? 'on' : 'off');

/**
 * Readable labels for stored settings. A feature that adds a setting adds one
 * line here; keys without an entry are still diffed, using the raw key and JSON.
 */
export const SETTING_DESCRIPTORS: Record<string, SettingDescriptor> = {
  defaultInterval: { label: 'Default interval', format: formatInterval },
  defaultIdleTimeout: { label: 'Idle timeout', format: formatInterval },
  defaultEnabled: { label: 'Default enabled', format: yesNo },
};

const formatValue = (key: string, value: any): string => {
  const d = SETTING_DESCRIPTORS[key];
  if (d) return d.format(value);
  return value === undefined ? '(unset)' : JSON.stringify(value);
};

export type SettingChange = {
  key: string;
  label: string;
  from: string;
  to: string;
};

export const diffSettings = (
  oldSettings: Partial<SettingsType> & Record<string, any>,
  newSettings: Partial<SettingsType> & Record<string, any>
): SettingChange[] => {
  const keys = Array.from(
    new Set([
      ...Object.keys(oldSettings ?? {}),
      ...Object.keys(newSettings ?? {}),
    ])
  );
  const changes: SettingChange[] = [];
  for (const key of keys) {
    const from = formatValue(key, oldSettings?.[key]);
    const to = formatValue(key, newSettings?.[key]);
    if (from !== to) {
      changes.push({
        key,
        label: SETTING_DESCRIPTORS[key]?.label ?? key,
        from,
        to,
      });
    }
  }
  return changes;
};

/** Record one "Settings changed" entry with a key-by-key old -> new list. */
export const recordSettingsChange = (
  log: ActivityRecorder,
  oldSettings: Record<string, any>,
  newSettings: Record<string, any>
): SettingChange[] => {
  const changes = diffSettings(oldSettings, newSettings);
  if (changes.length === 0) return changes;
  log.record(
    'settings',
    changes.length === 1
      ? `Setting changed: ${changes[0].label}`
      : `${changes.length} settings changed`,
    {
      details: changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('\n'),
    }
  );
  return changes;
};

export const describeSettings = (s: SettingsType): string =>
  `default interval ${formatInterval(s.defaultInterval)}, idle timeout ${formatInterval(
    s.defaultIdleTimeout
  )}, default enabled: ${yesNo(s.defaultEnabled)}`;

// ---- snapshot (what the log page shows) -----------------------------------

export type SummaryTab = {
  tabId: number;
  title?: string;
  url?: string;
  host?: string;
  intervalMs: number;
  nextReloadAt: number | null;
};

export type IdleStatus = {
  state: 'active' | 'idle-pending' | 'paused-by-idle';
  pausesAt?: number | null;
};

export type ActivitySummary = {
  version: string;
  trackedTabs: number;
  enabledTabs: number;
  globalEnabled: boolean;
  idle: IdleStatus;
  defaultInterval: Interval;
  defaultIdleTimeout: Interval;
  defaultEnabled: boolean;
  tabs: SummaryTab[];
};

export type ActivitySnapshot = {
  now: number;
  startedAt: number;
  cap: number;
  entries: ActivityEntry[];
  summary: ActivitySummary;
};

export const describeIdle = (idle: IdleStatus, now: number): string => {
  switch (idle.state) {
    case 'idle-pending':
      return idle.pausesAt
        ? `Browser idle, reloading pauses in ${formatMs(Math.max(0, idle.pausesAt - now))}`
        : 'Browser idle';
    case 'paused-by-idle':
      return 'Paused because the browser was idle (re-enable from the popup)';
    default:
      return 'Active';
  }
};

// ---- plain-text export ----------------------------------------------------

export type TextOptions = { fullUrls?: boolean; locale?: string };

const pad = (n: number) => String(n).padStart(2, '0');

export const formatTime = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const entryTabLabel = (e: ActivityEntry, fullUrls = false): string => {
  if (e.tabId === undefined) return '';
  const where = fullUrls ? (e.url ?? e.host) : e.host;
  const parts = [e.tabTitle, where].filter(Boolean).join(' - ');
  return parts ? `${parts} (tab ${e.tabId})` : `tab ${e.tabId}`;
};

export const formatEntryText = (
  e: ActivityEntry,
  opts: TextOptions = {}
): string => {
  const tab = entryTabLabel(e, opts.fullUrls);
  const head = `${formatTime(e.time)}  [${kindLabel(e.kind)}]${tab ? ` ${tab}:` : ''} ${e.message}`;
  if (!e.details) return head;
  return `${head}\n${e.details
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')}`;
};

export const formatSnapshotText = (
  snap: ActivitySnapshot,
  opts: TextOptions = {}
): string => {
  const s = snap.summary;
  const lines = [
    `AutoReload ${s.version} activity log (in memory only, cleared when the browser or add-on restarts)`,
    `Generated ${formatTime(snap.now)}`,
    '',
    'Currently running',
    `  Tabs reloading: ${s.enabledTabs} of ${s.trackedTabs} tracked`,
    `  Browser: ${describeIdle(s.idle, snap.now)}`,
    `  Defaults: interval ${formatInterval(s.defaultInterval)}, idle timeout ${formatInterval(
      s.defaultIdleTimeout
    )}, default enabled: ${yesNo(s.defaultEnabled)}`,
  ];
  for (const t of s.tabs) {
    const where = opts.fullUrls ? (t.url ?? t.host) : t.host;
    const next =
      t.nextReloadAt === null
        ? ''
        : `, next reload in ${formatMs(Math.max(0, t.nextReloadAt - snap.now))}`;
    lines.push(
      `  - ${[t.title, where].filter(Boolean).join(' - ') || `tab ${t.tabId}`}: every ${formatMs(
        t.intervalMs
      )}${next}`
    );
  }
  lines.push(
    '',
    `Entries (newest first, ${snap.entries.length} of max ${snap.cap})`
  );
  for (const e of snap.entries.slice().reverse()) {
    lines.push(formatEntryText(e, opts));
  }
  return lines.join('\n') + '\n';
};
