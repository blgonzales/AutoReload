import {
  ServerBrowserMessage,
  convertIntervalToTimeoutInterval,
  getLogger,
} from './common';
import {
  getDefaultIdleTimeout,
  notificationPermissions,
  retryOnErrorPermissions,
} from './config';
import { getSettings, handleRequest } from './server';
import ReloadManager from './util/ReloadManager';
import ErrorRetry, {
  READ_NAVIGATION_STATUS,
  UnreportedNavigations,
} from './util/ErrorRetry';
import RecoveryNotifier, { BADGE_COLOR } from './util/RecoveryNotifier';

const reloadManager = new ReloadManager();

// remembers which pages are failing and says so when one loads again
const recovery = new RecoveryNotifier({
  isTracking: async () => (await getSettings()).retryOnError,
  canNotify: async () =>
    (await getSettings()).notifyOnRecovery &&
    !!browser.notifications &&
    (await browser.permissions.contains(notificationPermissions)),
  notify: async (id, title, message) => {
    await browser.notifications.create(id, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/96.png'),
      title,
      message,
    });
  },
  setIndicator: async (tabId, indicator) => {
    // null resets the tab to the add-on's default badge and title
    const reset = (value: string | null) => value as unknown as string;
    await browser.browserAction.setBadgeText({
      tabId,
      text: reset(indicator ? indicator.text : null),
    });
    await browser.browserAction.setBadgeBackgroundColor({
      tabId,
      color: indicator ? BADGE_COLOR : (null as unknown as string),
    });
    await browser.browserAction.setTitle({
      tabId,
      title: reset(indicator ? indicator.title : null),
    });
  },
  isPrivate: async (tabId) => (await browser.tabs.get(tabId)).incognito,
  focusTab: async (tabId) => {
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
  },
  clearNotification: async (id) => {
    await browser.notifications.clear(id);
  },
});

const errorRetry = new ErrorRetry({
  onFailure: ({ tabId, url, statusCode, delay, maxAttempts }) =>
    recovery.onFailure(tabId, url, { statusCode }, delay, maxAttempts),
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
  recovery.forget(tabId);
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
  recovery.onStarted(details.tabId, details.url);
};

const handleMainFrameError = (
  details: browser.webRequest._OnErrorOccurredDetails
) => {
  unreportedNavigations.onReported(details.tabId);
  recovery
    .onNetworkError(details.tabId, details.url, details.error)
    .catch((error) => getLogger().error('Recovery handler failed', error));
};

// A service worker answered the navigation, so webRequest never reported its
// status: read it from the loaded page instead.
const handleTabComplete = async (
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab
) => {
  if (changeInfo.status) {
    // Firefox resets per-tab badge and title on navigation
    recovery.refreshIndicator(tabId).catch(() => undefined);
  }
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
      const url = tab.url || navigation.url;
      await errorRetry.onMainFrameCompleted(
        tabId,
        url,
        Number(status),
        navigation.method
      );
      await recovery.onSuccess(tabId, url, Number(status));
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

  recovery
    .onSuccess(details.tabId, details.url, details.statusCode)
    .catch((error) => getLogger().error('Recovery handler failed', error));
};

const handleNotificationClicked = (id: string) => {
  recovery
    .onNotificationClicked(id)
    .catch((error) => getLogger().error('Notification click failed', error));
};

const syncErrorRetryListener = async () => {
  const granted = await browser.permissions.contains(retryOnErrorPermissions);

  if (!granted || !browser.webRequest) {
    errorRetry.forgetAll();
    recovery.forgetAll();
    return;
  }

  // the notifications API only exists once its optional permission is granted
  if (
    browser.notifications &&
    !browser.notifications.onClicked.hasListener(handleNotificationClicked)
  ) {
    browser.notifications.onClicked.addListener(handleNotificationClicked);
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
