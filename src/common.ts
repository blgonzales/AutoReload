import { isDebugModeEnabled, isVerboseModeEnabled } from './config';

export type Interval = {
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
};

type IntervalValue = Interval & {
  value: number;
};

type ResponseType = 'tabStateResponse';
type ClientMessageType = 'tabStateResponse' | 'appStateResponse';
type ServerMessageType = 'getTabState' | 'updateTabState' | 'updateAppState';

export type ResponseMessage = {
  type: ResponseType;
  data?: TabStateType | AppStateType;
};

export type ClientBrowserMessage = {
  type: ClientMessageType;
  data?: TabStateType | AppStateType;
};

export type ServerBrowserMessage = {
  type: ServerMessageType;
  data?: TabStateType | AppStateType;
};

export interface TabStateType {
  enabled: boolean;
  interval: Interval;
}

export interface AppStateType {
  enabled: boolean;
  numberOfTabs: number;
  defaultSettings: SettingsType;
}

export type SettingsType = {
  defaultInterval: Interval;
  defaultIdleTimeout: Interval;
  defaultEnabled: boolean;
};

export const getDefaultIntervalSettings = (): IntervalValue[] => {
  const result = [];
  let hours = 0,
    minutes = 0,
    seconds = 0;

  for (let x = 1; x <= 10; x++) {
    if (x % 2) minutes++;
    if (x % 2) seconds = 0;
    else seconds = 30;

    result.push({
      hours: hours,
      minutes: minutes,
      seconds: seconds,
      millis: 0,
    });
  }

  return result.map(
    (interval): IntervalValue => ({
      ...interval,
      value: convertIntervalToTimeoutInterval(interval),
    })
  );
};

export const getDefaultIdleTimeoutSettings = (): IntervalValue[] => {
  const result = [];
  let hours = 0,
    minutes = 0,
    seconds = 0;

  for (let x = 1; x <= 15; x++) {
    if (x % 2) hours++;
    if (x % 2) minutes = 0;
    else minutes = 30;

    result.push({
      hours: hours,
      minutes: minutes,
      seconds: seconds,
      millis: 0,
    });
  }

  return result.map(
    (interval): IntervalValue => ({
      ...interval,
      value: convertIntervalToTimeoutInterval(interval),
    })
  );
};

export const convertIntervalToTimeoutInterval = (
  interval: Interval
): number => {
  return (
    interval.hours * 3600000 +
    interval.minutes * 60000 +
    interval.seconds * 1000 +
    interval.millis
  );
};

export const isExtension = () => window.browser !== undefined;

export const isDarkMode = () => window.matchMedia && !!window.matchMedia('(prefers-color-scheme: dark)').matches;

export const getLogger = () => {
  const prefix = '[AutoReload]';

  return {
    log: (message: string, ...args: any) =>
      console.log(`${prefix}[LOG] ${message}`, ...args),
    debug: (message: string, ...args: any) => {
      if (!isDebugModeEnabled()) {
        return;
      }
      console.log(`${prefix}[DEBUG] ${message}`, ...args);
    },
    verbose: (message: string, ...args: any) => {
      if (!isVerboseModeEnabled()) {
        return;
      }
      console.log(`${prefix}[VERBOSE] ${message}`, ...args);
    },
    error: (message: string, ...args: any) =>
      console.error(`${prefix}[ERROR] ${message}`, ...args),
  };
};
