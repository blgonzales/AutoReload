import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout } from './config';
import { getSettings, handleRequest } from './server';
import ReloadManager from './util/ReloadManager';
import RememberedPages from './util/RememberedPages';

const reloadManager = new ReloadManager();

// optional per-page memory of reload settings (storage.local, off by default)
const rememberedPages = new RememberedPages({
  storage: browser.storage.local,
  tabs: browser.tabs,
  isFeatureEnabled: async () => (await getSettings()).rememberPages,
  isTabEnabled: (tabId) =>
    reloadManager.getBrowserTab(tabId)?.isEnabled() ?? false,
  enableTab: (tabId, interval) =>
    reloadManager.enableBrowserTab(tabId, interval),
});

// event handler for custom events for messaging front-end interval popup
browser.runtime.onMessage.addListener(async (message: ServerBrowserMessage) => {
  await handleRequest(reloadManager, message, rememberedPages);
});

// handle deleting tab state & reload timer when tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  const browserTab = reloadManager.getBrowserTab(tabId);
  if (browserTab) {
    getLogger().debug(`Browser Tab ${tabId} closed, cleaning up`);
    reloadManager.deleteBrowserTab(browserTab);
  }
});

// resume remembered pages once they finish loading
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    rememberedPages
      .onTabComplete(tabId, tab.url)
      .catch((e) => getLogger().error('Failed to restore remembered page', e));
  }
});

// cover tabs brought back by session restore
rememberedPages
  .restoreAll()
  .catch((e) => getLogger().error('Failed to restore remembered pages', e));

// set to check for idle every 15 seconds (the browser minimum)
browser.idle.setDetectionInterval(15);

// Handle disabling reloading tabs after idle state threshold
browser.idle.onStateChanged.addListener(async (newState) => {
  getLogger().debug(`Idle state changed to ${newState}`);

  if (newState === 'idle') {
    const idleInterval = await getDefaultIdleTimeout();
    reloadManager.createIdleTimer(
      convertIntervalToTimeoutInterval(idleInterval)
    );
  } else if (newState === 'active') {
    reloadManager.cancelIdleTimer();
  }
});
