import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import { getDefaultIdleTimeout, retryOnErrorPermissions } from './config';
import { getSettings, handleRequest } from './server';
import ReloadManager from './util/ReloadManager';
import ErrorRetry, {
  READ_NAVIGATION_STATUS,
  UnreportedNavigations,
} from './util/ErrorRetry';

const reloadManager = new ReloadManager();

const errorRetry = new ErrorRetry({
  getOptions: async () => {
    const settings = await getSettings();
    return {
      enabled: settings.retryOnError,
      statusCodes: settings.retryStatusCodes,
      delay: convertIntervalToTimeoutInterval(settings.retryDelay),
      backoff: settings.retryBackoff,
      maxDelay: convertIntervalToTimeoutInterval(settings.retryMaxDelay),
      maxAttempts: settings.retryMaxAttempts,
    };
  },
  getTabUrl: async (tabId) => (await browser.tabs.get(tabId)).url,
  reloadTab: (tabId) => browser.tabs.reload(tabId),
});

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
  errorRetry.forget(tabId);
  unreportedNavigations.forget(tabId);
});

// retry top-level documents that come back with one of the configured HTTP
// error codes. webRequest is an optional permission, so the listener is only
// attached once the user has granted it from the settings page.
const unreportedNavigations = new UnreportedNavigations();

const handleMainFrameStarted = (
  details: browser.webRequest._OnBeforeRequestDetails
) => {
  unreportedNavigations.onStarted(details.tabId, details.url, details.method);
};

const handleMainFrameError = (
  details: browser.webRequest._OnErrorOccurredDetails
) => {
  unreportedNavigations.onReported(details.tabId);
};

// A service worker answered the navigation, so webRequest never reported its
// status: read it from the loaded page instead.
const handleTabComplete = async (
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab
) => {
  if (changeInfo.status !== 'complete') {
    return;
  }
  // let a late webRequest onCompleted for the same load arrive first
  await new Promise((resolve) => setTimeout(resolve, 250));

  const navigation = unreportedNavigations.takeUnreported(tabId);
  if (!navigation) {
    return;
  }

  try {
    const [status] = await browser.tabs.executeScript(tabId, {
      code: READ_NAVIGATION_STATUS,
    });
    if (status) {
      await errorRetry.onMainFrameCompleted(
        tabId,
        tab.url || navigation.url,
        Number(status),
        navigation.method
      );
    }
  } catch (error) {
    // e.g. Firefox error pages and about: pages can't be scripted
    getLogger().debug(`Could not read status of tab ${tabId}`, error);
  }
};

const handleMainFrameCompleted = (
  details: browser.webRequest._OnCompletedDetails
) => {
  unreportedNavigations.onReported(details.tabId);

  const retryAfter = details.responseHeaders?.find(
    (header) => header.name.toLowerCase() === 'retry-after'
  )?.value;

  errorRetry
    .onMainFrameCompleted(
      details.tabId,
      details.url,
      details.statusCode,
      details.method,
      retryAfter
    )
    .catch((error) => getLogger().error('Error retry handler failed', error));
};

const syncErrorRetryListener = async () => {
  const granted = await browser.permissions.contains(retryOnErrorPermissions);

  if (!granted || !browser.webRequest) {
    errorRetry.forgetAll();
    return;
  }

  if (!browser.webRequest.onCompleted.hasListener(handleMainFrameCompleted)) {
    getLogger().debug('Listening for HTTP error responses');
    browser.webRequest.onCompleted.addListener(
      handleMainFrameCompleted,
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['responseHeaders']
    );
    browser.webRequest.onBeforeRequest.addListener(handleMainFrameStarted, {
      urls: ['<all_urls>'],
      types: ['main_frame'],
    });
    browser.webRequest.onErrorOccurred.addListener(handleMainFrameError, {
      urls: ['<all_urls>'],
      types: ['main_frame'],
    });
    browser.tabs.onUpdated.addListener(handleTabComplete);
  }
};

syncErrorRetryListener().catch((error) =>
  getLogger().error('Failed to set up error retry listener', error)
);
browser.permissions.onAdded?.addListener(syncErrorRetryListener);
browser.permissions.onRemoved?.addListener(syncErrorRetryListener);

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
