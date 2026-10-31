import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout } from './config';
import { getSettings, handleRequest } from './server';
import ReloadManager, { PAUSED_STORAGE_KEY } from './util/ReloadManager';

const reloadManager = new ReloadManager();

// tabs paused by the idle timeout survive a restart of the background page
reloadManager.setPauseStore(browser.storage.local);
browser.storage.local
  .get(PAUSED_STORAGE_KEY)
  .then(async (stored) => {
    const tabs = await browser.tabs.query({});
    reloadManager.restorePaused(
      stored[PAUSED_STORAGE_KEY],
      tabs.map((tab) => Number(tab.id))
    );
  })
  .catch((e) => getLogger().error('Failed to restore paused tabs', e));

getSettings().then((settings) =>
  reloadManager.setShowCountdown(settings.showCountdown)
);

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
let idleStateCount = 0;
browser.idle.onStateChanged.addListener(async (newState) => {
  getLogger().debug(`Idle state changed to ${newState}`);
  const thisChange = ++idleStateCount;

  if (newState === 'idle') {
    const idleInterval = await getDefaultIdleTimeout();
    // the user may have come back while the setting was being read
    if (thisChange !== idleStateCount) {
      return;
    }
    reloadManager.createIdleTimer(
      convertIntervalToTimeoutInterval(idleInterval)
    );
  } else if (newState === 'active') {
    reloadManager.cancelIdleTimer();
    // tabs the idle pause switched off start again now the user is back
    reloadManager.resumeFromIdle();
  }
});
