import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout } from './config';
import { handleRequest } from './server';
import ReloadManager from './util/ReloadManager';

const reloadManager = new ReloadManager();

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
});

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
