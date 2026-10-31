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

export const retryOnError = false;
// common "try again later" errors; users can pick others or add their own
export const retryStatusCodePresets: { code: number; label: string }[] = [
  { code: 408, label: 'Request Timeout' },
  { code: 429, label: 'Too Many Requests' },
  { code: 500, label: 'Internal Server Error' },
  { code: 502, label: 'Bad Gateway' },
  { code: 503, label: 'Service Unavailable' },
  { code: 504, label: 'Gateway Timeout' },
  { code: 520, label: 'Unknown Error (Cloudflare)' },
  { code: 521, label: 'Web Server Is Down (Cloudflare)' },
  { code: 522, label: 'Connection Timed Out (Cloudflare)' },
  { code: 523, label: 'Origin Is Unreachable (Cloudflare)' },
  { code: 524, label: 'A Timeout Occurred (Cloudflare)' },
];
export const retryStatusCodes = [502, 503, 504];
export const retryDelay: Interval = {
  hours: 0,
  minutes: 0,
  seconds: 30,
  millis: 0,
};
export const retryBackoff = false;
// retries per failing page before giving up; 0 = unlimited
export const retryMaxAttempts = 0;
export const retryMaxAttemptsChoices = [0, 3, 5, 10, 25];
export const retryMaxDelay: Interval = {
  hours: 0,
  minutes: 10,
  seconds: 0,
  millis: 0,
};

// optional permissions needed to see response status codes for error retries
export const retryOnErrorPermissions: browser.permissions.Permissions = {
  permissions: ['webRequest'],
  origins: ['<all_urls>'],
};

export const getAppDefaults = (): SettingsType => ({
  defaultEnabled: defaultEnabled,
  defaultInterval: defaultInterval,
  defaultIdleTimeout: disableAfterIdleStateThreshold,
  retryOnError: retryOnError,
  retryStatusCodes: retryStatusCodes,
  retryDelay: retryDelay,
  retryBackoff: retryBackoff,
  retryMaxDelay: retryMaxDelay,
  retryMaxAttempts: retryMaxAttempts,
});

export const getDefaultIdleTimeout = async (): Promise<Interval> =>
  (await getSettings()).defaultIdleTimeout;
