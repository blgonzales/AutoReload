import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout } from './config';
import { getSettings, handleRequest } from './server';
import ReloadManager from './util/ReloadManager';
import SmartTiming from './util/SmartTiming';

const smartTiming = new SmartTiming({
  getOptions: async () => {
    const settings = await getSettings();
    return {
      skipWhileLoading: settings.skipReloadWhileLoading,
      restartOnManualLoad: settings.restartTimerOnManualLoad,
    };
  },
  getTabStatus: async (tabId) => (await browser.tabs.get(tabId)).status,
  restartTimer: (tabId) => reloadManager.getBrowserTab(tabId)?.restartTimer(),
});

const reloadManager: ReloadManager = new ReloadManager(smartTiming);

// event handler for custom events for messaging front-end interval popup
browser.runtime.onMessage.addListener(async (message: ServerBrowserMessage) => {
  await handleRequest(reloadManager, message);
});

// handle deleting tab state & reload timer when tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  const browserTab = reloadManager.getBrowserTab(tabId);
  if (browserTab) {
    getLogger().debug(`Browser Tab ${tabId} closed, cleaning up`);
    reloadManager.deleteBrowserTab(browserTab);
  }
  smartTiming.forget(tabId);
});

// a tab that starts loading outside of AutoReload's own reload (user reload,
// navigation, link click) restarts its countdown when that option is on
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') {
      return;
    }
    smartTiming
      .onTabLoading(tabId)
      .catch((error) =>
        getLogger().error('Smart timing handler failed', error)
      );
  },
  { properties: ['status'] }
);

// set to check for idle every 15 seconds (the browser minimum)
browser.idle.setDetectionInterval(15);

// Handle disabling reloading tabs after idle state threshold
browser.idle.onStateChanged.addListener(async (newState) => {
  getLogger().debug(`Idle state changed to ${newState}`);

  if (newState === 'idle') {
    const idleInterval = await getDefaultIdleTimeout();
    const idleTimeout = convertIntervalToTimeoutInterval(idleInterval);
    // a zero timeout is the "Never" choice: keep reloading while away
    if (idleTimeout > 0) {
      reloadManager.createIdleTimer(idleTimeout);
    }
  } else if (newState === 'active') {
    reloadManager.cancelIdleTimer();
  }
});
