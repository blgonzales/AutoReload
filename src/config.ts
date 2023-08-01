import { AppStateType, Interval, SettingsType } from './common';
import { getSettings } from './server';

export const isDebugModeEnabled = () => true;
export const isVerboseModeEnabled = () => false;

export const defaultEnabled = false;

export const defaultInterval: Interval = {
  hours: 0,
  minutes: 1,
  seconds: 30,
  millis: 0,
};

export const disableAfterIdleState = true;
export const disableAfterIdleStateThreshold: Interval = {
  hours: 2,
  minutes: 0,
  seconds: 0,
  millis: 0,
};

export const getAppDefaults = (): SettingsType => ({
  defaultEnabled: defaultEnabled,
  defaultInterval: defaultInterval,
  defaultIdleTimeout: disableAfterIdleStateThreshold,
});

export const getDefaultIdleTimeout = async (): Promise<Interval> =>
  (await getSettings()).defaultIdleTimeout;
