import { ClientBrowserMessage } from './client';
import {
  AppStateType,
  ServerBrowserMessage,
  getLogger,
  SettingsType,
  isExtension,
  TabStateType,
} from './common';
import { getAppDefaults } from './config';
import ReloadManager from './util/ReloadManager';
import RememberedPages from './util/RememberedPages';

export const sendRequest = (message: ClientBrowserMessage) => {
  getLogger().verbose(`[Server] Send request`, message);
  browser.runtime.sendMessage(message);
};

export const handleRequest = async (
  reloadManager: ReloadManager,
  event: ServerBrowserMessage,
  remembered?: RememberedPages
) => {
  let tab;
  getLogger().verbose('[Server] Received event message', event);

  switch (event.type) {
    case 'getTabState':
      tab = await reloadManager.getOrCreateBrowserTab(await getSettings());
      if (!tab) {
        getLogger().error('Current tab could not be found', event);
        return;
      }

      sendRequest({
        type: 'tabStateResponse',
        data: {
          enabled: tab.isEnabled(),
          interval: tab.getInterval(),
        },
      });

      sendAppState(reloadManager, remembered);
      break;

    case 'updateTabState':
      if (!event.data) {
        getLogger().error('No data found in message to updateTabState');
        return;
      }

      tab = await reloadManager.getOrCreateBrowserTab(await getSettings());
      if (!tab) {
        getLogger().error('Current tab could not be found', event);
        return;
      }

      tab.update(event.data as TabStateType);
      await remembered?.onTabStateUpdated(
        tab.getTabId(),
        event.data as TabStateType
      );
      sendAppState(reloadManager, remembered);
      break;

    case 'forgetRememberedPages':
      await remembered?.forgetAll();
      sendAppState(reloadManager, remembered);
      break;

    case 'forgetRememberedPage': {
      const tabId = await reloadManager.getCurrentTabId();
      const url = tabId ? (await browser.tabs.get(tabId)).url : undefined;
      if (url) {
        await remembered?.forget(url);
      }
      sendAppState(reloadManager, remembered);
      break;
    }

    case 'updateAppState':
      const appState = event.data as AppStateType;

      reloadManager.update(appState);

      if (appState.defaultSettings !== undefined) {
        saveSettings(appState.defaultSettings);
      }
      sendAppState(reloadManager, remembered);
      break;

    default:
      getLogger().error('Unknown browser event message received', event);
      break;
  }
};

async function sendAppState(
  reloadManager: ReloadManager,
  remembered?: RememberedPages
) {
  const numberOfTabs = reloadManager.getNumberOfTabs();
  const numberOfEnableTabs = reloadManager.getNumberOfEnabledTabs();
  const settings = await getSettings();

  // is the page open in the current tab remembered? (shown in the popup)
  let pageRemembered = false;
  try {
    const tabId = await reloadManager.getCurrentTabId();
    const url = tabId ? (await browser.tabs.get(tabId)).url : undefined;
    pageRemembered =
      settings.rememberPages && !!url && !!(await remembered?.get(url));
  } catch (error) {
    getLogger().debug('Could not check whether the page is remembered', error);
  }

  sendRequest({
    type: 'appStateResponse',
    data: {
      enabled: numberOfTabs === numberOfEnableTabs,
      numberOfTabs: numberOfTabs,
      rememberedPageCount: (await remembered?.count()) ?? 0,
      pageRemembered,
      ...settings,
      defaultSettings: settings,
    },
  });
}

export const saveSettings = (settings: SettingsType): void => {
  getLogger().debug(`Saving settings`, settings);
  if (!isExtension()) {
    return;
  }
  browser.storage.sync.set({ settings });
};

export const getSettings = async (): Promise<SettingsType> => {
  //   getLogger().verbose(`Getting settings`);
  if (!isExtension()) {
    return new Promise((resolve) => resolve(getAppDefaults()));
  }
  const settings = (await browser.storage.sync.get('settings'))
    .settings as SettingsType;

  const settingsWithDefaults = {
    ...getAppDefaults(),
    ...settings,
  };

  //   getLogger().verbose(`Fetched settings`, settingsWithDefaults);
  return settingsWithDefaults;
};
