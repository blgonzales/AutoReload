import React, { createContext, useContext, useEffect, useState } from 'react';
import { TabStateType } from '../common';
import { defaultEnabled, defaultInterval } from '../config';
import { getTabState, updateTabState } from '../client';

export type TabContextType = {
  tabData: TabStateType;
  setTabData: (data: TabStateType) => void;
};

export const TabContext = createContext<TabContextType>({} as TabContextType);
export const useTabContext = () => useContext(TabContext) as TabContextType;

export const TabProvider = (props: { children: any }) => {
  const [data, setData] = useState<TabStateType>({
    interval: defaultInterval,
    enabled: defaultEnabled,
  });

  useEffect(() => {
    // get app state on mount
    const fetchAppData = async () => {
      const data = await getTabState();
      setData(data);
    };

    fetchAppData().catch(console.error);
  }, []);

  const updateTabData = (newData: TabStateType) => {
    setData(newData);
    updateTabState(newData);
  };

  return (
    <TabContext.Provider
      value={{
        tabData: data,
        setTabData: updateTabData,
      }}
    >
      {props.children}
    </TabContext.Provider>
  );
};
