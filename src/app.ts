import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout } from './config';
import { getSettings, handleRequest } from './server';
import ReloadManager from './util/ReloadManager';
import {
  activityLog,
  describeSettings,
  tabInfoFromTab,
} from './util/ActivityLog';
import { attachActivityPort } from './util/ActivityPort';

const reloadManager = new ReloadManager();

// Private-window tabs (or tabs whose state is unknown) never expose their
// title or address to the activity log.
const getTabInfo = async (tabId: number) => {
  return tabInfoFromTab(await browser.tabs.get(tabId));
};
activityLog.setTabInfoProvider(getTabInfo);

// the activity log page connects with a port and receives live snapshots
browser.runtime.onConnect.addListener((port) =>
  attachActivityPort(port, {
    log: activityLog,
    manager: reloadManager,
    getSettings,
    getTabInfo,
    version: browser.runtime.getManifest().version,
  })
);

// errors that escape the handlers below end up in the activity log too
self.addEventListener('error', (event) => {
  activityLog.record('error', `Unexpected error: ${event.message}`);
});
self.addEventListener('unhandledrejection', (event) => {
  activityLog.record('error', `Unhandled error: ${String(event.reason)}`);
});

getSettings()
  .then((settings) =>
    activityLog.record(
      'startup',
      `AutoReload ${browser.runtime.getManifest().version} started`,
      {
        details: `${describeSettings(settings)}\nNo tabs are reloading yet: a tab is added when you switch AutoReload on for it in the popup.`,
      }
    )
  )
  .catch((e) => activityLog.record('error', `Could not read settings: ${e}`));

// event handler for custom events for messaging front-end interval popup
browser.runtime.onMessage.addListener(async (message: ServerBrowserMessage) => {
  try {
    await handleRequest(reloadManager, message);
  } catch (e) {
    getLogger().error('Failed to handle message', message, e);
    activityLog.record('error', `Failed to handle "${message?.type}": ${e}`);
  }
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
    const hadTimer = reloadManager.cancelIdleTimer();
    activityLog.record(
      'idle',
      hadTimer
        ? 'Browser active again: idle timer cancelled, reloading continues'
        : 'Browser active again'
    );
  }
});
