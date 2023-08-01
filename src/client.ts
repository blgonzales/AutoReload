import {
  TabStateType,
  AppStateType,
  ResponseMessage,
  ServerBrowserMessage,
  getLogger,
  isExtension,
} from './common';
import { defaultEnabled, defaultInterval } from './config';

type ClientMessageType = 'tabStateResponse' | 'appStateResponse';

export type ClientBrowserMessage = {
  type: ClientMessageType;
  data?: TabStateType | AppStateType;
};

const awaitMessage = async (): Promise<ResponseMessage> => {
  return await new Promise((resolve) => {
    const handler = (message: ResponseMessage) => {
      resolve(message);
      browser.runtime.onMessage.removeListener(handler);
    };
    browser.runtime.onMessage.addListener(handler);
  });
};

export const sendRequest = async (
  message: ServerBrowserMessage
): Promise<ResponseMessage> => {
  getLogger().verbose(`[Client] Send server browser message`, message);
  browser.runtime.sendMessage(message);
  return await awaitMessage();
};

export const getTabState = async (): Promise<TabStateType> => {
  if (!isExtension()) {
    // if not running as an extension, return default data
    return {
      enabled: defaultEnabled,
      interval: defaultInterval,
    };
  }

  const response = await sendRequest({
    type: 'getTabState',
  });

  return response.data as TabStateType;
};

export const appStateHandler = (
  event: ClientBrowserMessage
): AppStateType | undefined => {
  getLogger().verbose('[Client] Received event message', event);
  switch (event.type) {
    case 'appStateResponse':
      return event.data as AppStateType;
    default:
      return;
  }
};

export const updateTabState = (newData: TabStateType) => {
  if (!isExtension()) {
    return;
  }

  sendRequest({
    type: 'updateTabState',
    data: newData,
  });
};

export const updateAppState = (newData: AppStateType) => {
  getLogger().debug('UpdateAppState', newData);
  if (!isExtension()) {
    return;
  }

  sendRequest({
    type: 'updateAppState',
    data: newData,
  });
};
