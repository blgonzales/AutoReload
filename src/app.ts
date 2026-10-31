import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout, offlineModePermissions } from './config';
import { handleRequest } from './server';
import ReloadManager from './util/ReloadManager';
import OfflineModeManager, {
  OfflineStore,
  isOfflineMessage,
} from './util/OfflineMode';

const offlineMode = new OfflineModeManager({
  store: new OfflineStore(browser.storage.local, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
  }),
  executeScript: (tabId, code) => browser.tabs.executeScript(tabId, { code }),
  queryTabs: () => browser.tabs.query({}),
  setIndicator: (tabId, indicator) => {
    // per-tab badge and tooltip; null goes back to the defaults
    browser.browserAction.setBadgeText({
      tabId,
      text: indicator ? indicator.text : null,
    });
    browser.browserAction.setTitle({
      tabId,
      title: indicator ? indicator.title : null,
    });
    if (indicator) {
      browser.browserAction.setBadgeBackgroundColor({
        tabId,
        color: '#c45500',
      });
      // white text, for contrast (Firefox 63+)
      (browser.browserAction as any).setBadgeTextColor?.({
        tabId,
        color: '#ffffff',
      });
    }
  },
  log: (message, detail) => getLogger().debug(message, detail),
});

const reloadManager = new ReloadManager();

// event handler for custom events for messaging front-end interval popup
browser.runtime.onMessage.addListener(async (message: ServerBrowserMessage) => {
  if (isOfflineMessage(message)) {
    return offlineMode.handleMessage(message);
  }
  await handleRequest(reloadManager, message);
});

// handle deleting tab state & reload timer when tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  offlineMode.forgetTab(tabId);
  const browserTab = reloadManager.getBrowserTab(tabId);
  if (browserTab) {
    getLogger().debug(`Browser Tab ${tabId} closed, cleaning up`);
    reloadManager.deleteBrowserTab(browserTab);
  }
});

// Offline mode: answer requests for the reserved worker path of enabled sites
// with the generated service worker script. webRequest (blocking + response
// filtering) is optional, so the listeners are attached only once granted.
const WORKER_URL_PATTERN = '*://*/*autoreload-offline-sw=*';

const handleWorkerRequest = async (
  details: browser.webRequest._OnBeforeRequestDetails
): Promise<browser.webRequest.BlockingResponse> => {
  await offlineMode.deps.store.ready();
  const script = offlineMode.workerScriptFor(details.url, details.method);
  if (script === null) {
    return {};
  }
  const encoder = new TextEncoder();
  const filter = browser.webRequest.filterResponseData(details.requestId);
  filter.ondata = () => {
    // discard the site's own response body
  };
  filter.onstop = () => {
    filter.write(encoder.encode(script));
    filter.close();
  };
  filter.onerror = () => getLogger().debug('Offline worker filter failed');
  return {};
};

const handleWorkerHeaders = (
  details: browser.webRequest._OnHeadersReceivedDetails
): browser.webRequest.BlockingResponse => {
  if (offlineMode.workerScriptFor(details.url, details.method) === null) {
    return {};
  }
  const dropped = [
    'content-type',
    'content-length',
    'cache-control',
    'expires',
    'etag',
    'last-modified',
    'pragma',
  ];
  const headers = (details.responseHeaders || []).filter(
    (header) => !dropped.includes(header.name.toLowerCase())
  );
  headers.push(
    { name: 'Content-Type', value: 'application/javascript' },
    { name: 'Cache-Control', value: 'no-store' }
  );
  return { responseHeaders: headers };
};

const syncOfflineListeners = async () => {
  const granted = await browser.permissions.contains(offlineModePermissions);
  if (!granted || !browser.webRequest?.filterResponseData) {
    return;
  }
  if (!browser.webRequest.onBeforeRequest.hasListener(handleWorkerRequest)) {
    browser.webRequest.onBeforeRequest.addListener(
      handleWorkerRequest,
      { urls: [WORKER_URL_PATTERN] },
      ['blocking']
    );
    browser.webRequest.onHeadersReceived.addListener(
      handleWorkerHeaders,
      { urls: [WORKER_URL_PATTERN] },
      ['blocking', 'responseHeaders']
    );
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete') {
        offlineMode
          .onTabComplete(tab)
          .catch((error) => getLogger().error('Offline mode failed', error));
      }
    });
  }
};

syncOfflineListeners().catch((error) =>
  getLogger().error('Failed to set up offline mode listeners', error)
);
browser.permissions.onAdded?.addListener(syncOfflineListeners);

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
