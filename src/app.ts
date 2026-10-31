import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout } from './config';
import { getSettings, handleRequest } from './server';
import KeepLoaded from './util/KeepLoaded';
import ReloadManager from './util/ReloadManager';

// stops Firefox and other add-ons (e.g. Auto Tab Discard) from unloading tabs
// that are being reloaded; also exposes keepLoaded.getDiscardStatus(tabId)
export const keepLoaded = new KeepLoaded({
  isEnabled: async () => (await getSettings()).keepTabsLoaded,
  getTab: (tabId) => browser.tabs.get(tabId),
  setAutoDiscardable: (tabId, value) =>
    // autoDiscardable is missing from the bundled type definitions
    browser.tabs.update(tabId, {
      autoDiscardable: value,
    } as browser.tabs._UpdateUpdateProperties),
  reload: (tabId) => browser.tabs.reload(tabId),
  waitForComplete: (tabId, timeoutMs) =>
    new Promise<boolean>((resolve) => {
      const finish = (result: boolean) => {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        resolve(result);
      };
      const listener = (
        updatedTabId: number,
        changeInfo: browser.tabs._OnUpdatedChangeInfo
      ) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      browser.tabs.onUpdated.addListener(listener);
    }),
});

// pure query for the toolbar badge/tooltip/popup: is this tab kept loaded,
// was it unloaded by someone else, or neither (null)?
export const getDiscardStatus = (tabId: number) =>
  keepLoaded.getDiscardStatus(tabId);

const reloadManager = new ReloadManager(keepLoaded);

// event handler for custom events for messaging front-end interval popup
browser.runtime.onMessage.addListener(async (message: ServerBrowserMessage) => {
  await handleRequest(reloadManager, message, keepLoaded);
});

// remember tabs that get unloaded behind AutoReload's back
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (changeInfo.discarded !== undefined) {
      keepLoaded.noteDiscarded(tabId, changeInfo.discarded);
    }
  },
  { properties: ['discarded'] }
);

// handle deleting tab state & reload timer when tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  const browserTab = reloadManager.getBrowserTab(tabId);
  if (browserTab) {
    getLogger().debug(`Browser Tab ${tabId} closed, cleaning up`);
    reloadManager.deleteBrowserTab(browserTab);
  }
  keepLoaded.forget(tabId);
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
