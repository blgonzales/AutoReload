import { SettingsType, convertIntervalToTimeoutInterval } from '../common';
import {
  ActivityLog,
  ActivitySnapshot,
  SummaryTab,
  PRIVATE_TAB_LABEL,
  TabInfo,
  hostOf,
} from './ActivityLog';
import ReloadManager from './ReloadManager';

export const ACTIVITY_PORT_NAME = 'autoreload-activity-log';

export type ActivityCommand = { type: 'clear' };

export interface PortLike {
  name: string;
  postMessage(message: unknown): void;
  onMessage: { addListener(l: (m: any) => void): void };
  onDisconnect: { addListener(l: () => void): void };
}

export type ActivityPortDeps = {
  log: ActivityLog;
  manager: ReloadManager;
  getSettings: () => Promise<SettingsType>;
  getTabInfo: (tabId: number) => Promise<TabInfo | null | undefined>;
  version: string;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
  tickMs?: number;
};

export const buildSnapshot = async (
  deps: Pick<
    ActivityPortDeps,
    'log' | 'manager' | 'getSettings' | 'getTabInfo' | 'version' | 'now'
  >
): Promise<ActivitySnapshot> => {
  const now = (deps.now ?? Date.now)();
  const settings = await deps.getSettings();

  const tabs: SummaryTab[] = [];
  for (const tab of deps.manager.getBrowserTabs()) {
    if (!tab.isEnabled()) continue;
    let info: TabInfo | null | undefined;
    try {
      info = await deps.getTabInfo(tab.getTabId());
    } catch {
      info = { private: true }; // unreadable: treat as private
    }
    const isPrivate = info?.private === true;
    tabs.push({
      tabId: tab.getTabId(),
      title: isPrivate ? PRIVATE_TAB_LABEL : info?.title,
      url: isPrivate ? undefined : info?.url,
      host: isPrivate ? undefined : hostOf(info?.url),
      intervalMs: convertIntervalToTimeoutInterval(tab.getInterval()),
      nextReloadAt: tab.getNextReloadAt(),
    });
  }

  return {
    now,
    startedAt: deps.log.startedAt,
    cap: deps.log.getCap(),
    entries: deps.log.getEntries(),
    summary: {
      version: deps.version,
      trackedTabs: deps.manager.getNumberOfTabs(),
      enabledTabs: deps.manager.getNumberOfEnabledTabs(),
      globalEnabled:
        deps.manager.getNumberOfTabs() > 0 && deps.manager.isEnabled(),
      idle: deps.manager.getIdleStatus(),
      defaultInterval: settings.defaultInterval,
      defaultIdleTimeout: settings.defaultIdleTimeout,
      defaultEnabled: settings.defaultEnabled,
      tabs,
    },
  };
};

/**
 * Handles connections from the activity log page. The page gets a fresh
 * snapshot on connect, whenever the log changes and once per tick (so
 * "next reload in N s" stays current). A port is used instead of
 * runtime.sendMessage so the popup's request/response messages never
 * see this traffic.
 */
export const attachActivityPort = (port: PortLike, deps: ActivityPortDeps) => {
  if (port.name !== ACTIVITY_PORT_NAME) return;

  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIv = deps.clearInterval ?? ((h) => clearInterval(h));
  let open = true;

  const push = async () => {
    if (!open) return;
    try {
      const snapshot = await buildSnapshot(deps);
      if (open) port.postMessage(snapshot);
    } catch {
      // page went away between building and sending
    }
  };

  const unsubscribe = deps.log.subscribe(() => {
    void push();
  });
  const timer = setIv(() => void push(), deps.tickMs ?? 1000);

  port.onMessage.addListener((cmd) => {
    if (cmd?.type === 'clear') {
      deps.log.clear();
    }
  });
  port.onDisconnect.addListener(() => {
    open = false;
    unsubscribe();
    clearIv(timer);
  });

  void push();
};
