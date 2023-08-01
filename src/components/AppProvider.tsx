import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  AppStateType,
  ClientBrowserMessage,
  isExtension as isExtensionCheck,
} from '../common';
import { appStateHandler, updateAppState } from '../client';
import { getAppDefaults } from '../config';

export type AppContextType = {
  settingsMode: boolean;
  setSettingsMode: (enabled: boolean) => void;
  appState: AppStateType;
  setAppState: (data: AppStateType) => void;
};

export const AppContext = createContext<AppContextType>({} as AppContextType);
export const useAppContext = () => useContext(AppContext) as AppContextType;

const isExtension = isExtensionCheck();

export const AppProvider = (props: { children: any }) => {
  const [settingsMode, setSettingsMode] = useState(false);
  const [appState, setAppState] = useState({
    enabled: true,
    numberOfTabs: 0,
    defaultSettings: getAppDefaults(),
  } as unknown as AppStateType);

  const handleAppState = useCallback(
    (event: ClientBrowserMessage) => {
      const appState = appStateHandler(event);
      if (appState) {
        setAppState(appState);
      }
    },
    [setAppState]
  );

  useEffect(() => {
    if (isExtension) {
      // create event listener for app state updates from backend
      browser.runtime.onMessage.addListener(handleAppState);
    }

    return () => {
      if (isExtension) {
        browser.runtime.onMessage.removeListener(handleAppState);
      }
    };
  }, [handleAppState]);

  const handleAppStateUpdate = (data: AppStateType) => {
    setAppState(data);
    updateAppState(data);
  };

  return (
    <AppContext.Provider
      value={{
        settingsMode,
        setSettingsMode,
        appState,
        setAppState: handleAppStateUpdate,
      }}
    >
      {props.children}
    </AppContext.Provider>
  );
};
