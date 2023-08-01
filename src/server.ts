import { Settings } from 'http2';
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

export const sendRequest = (message: ClientBrowserMessage) => {
  getLogger().verbose(`[Server] Send request`, message);
  browser.runtime.sendMessage(message);
};

export const handleRequest = async (
  reloadManager: ReloadManager,
  event: ServerBrowserMessage
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

      sendAppState(reloadManager);
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
      sendAppState(reloadManager);
      break;

    case 'updateAppState':
      const appState = event.data as AppStateType;

      reloadManager.update(appState);

      if (appState.defaultSettings !== undefined) {
        saveSettings(appState.defaultSettings);
      }
      sendAppState(reloadManager);
      break;

    default:
      getLogger().error('Unknown browser event message received', event);
      break;
  }
};

async function sendAppState(reloadManager: ReloadManager) {
  const numberOfTabs = reloadManager.getNumberOfTabs();
  const numberOfEnableTabs = reloadManager.getNumberOfEnabledTabs();
  const settings = await getSettings();

  sendRequest({
    type: 'appStateResponse',
    data: {
      enabled: numberOfTabs === numberOfEnableTabs,
      numberOfTabs: numberOfTabs,
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
