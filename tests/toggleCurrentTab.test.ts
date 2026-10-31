import { toggleCurrentTab } from '../src/util/toggleCurrentTab';
import { Interval, SettingsType } from '../src/common';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

const interval: Interval = { hours: 0, minutes: 2, seconds: 30, millis: 0 };
const settings = {
  defaultInterval: interval,
  defaultEnabled: false,
} as unknown as SettingsType;

const fakeTab = (enabled: boolean) => ({
  isEnabled: jest.fn().mockReturnValue(enabled),
  getInterval: jest.fn().mockReturnValue(interval),
});

const applyTabState = () => jest.fn().mockResolvedValue(undefined);

describe('toggleCurrentTab', () => {
  test('enables a disabled tab and keeps its interval', async () => {
    const tab = fakeTab(false);
    const getOrCreateBrowserTab = jest.fn().mockResolvedValue(tab);
    const apply = applyTabState();

    const result = await toggleCurrentTab({
      getSettings: jest.fn().mockResolvedValue(settings),
      getOrCreateBrowserTab,
      applyTabState: apply,
    });

    expect(result).toBe(true);
    expect(getOrCreateBrowserTab).toHaveBeenCalledWith(settings);
    expect(apply).toHaveBeenCalledWith({ enabled: true, interval });
  });

  test('disables an enabled tab', async () => {
    const tab = fakeTab(true);
    const apply = applyTabState();

    const result = await toggleCurrentTab({
      getSettings: jest.fn().mockResolvedValue(settings),
      getOrCreateBrowserTab: jest.fn().mockResolvedValue(tab),
      applyTabState: apply,
    });

    expect(result).toBe(false);
    expect(apply).toHaveBeenCalledWith({ enabled: false, interval });
  });

  test('does nothing when there is no active tab', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await toggleCurrentTab({
      getSettings: jest.fn().mockResolvedValue(settings),
      getOrCreateBrowserTab: jest.fn().mockResolvedValue(null),
      applyTabState: applyTabState(),
    });

    expect(result).toBeNull();
  });

  test('toggling twice returns to the original state', async () => {
    let enabled = false;
    const tab = {
      isEnabled: () => enabled,
      getInterval: () => interval,
    };
    const deps = {
      getSettings: jest.fn().mockResolvedValue(settings),
      getOrCreateBrowserTab: jest.fn().mockResolvedValue(tab),
      applyTabState: jest.fn(async (s: { enabled: boolean }) => {
        enabled = s.enabled;
      }),
    };

    expect(await toggleCurrentTab(deps)).toBe(true);
    expect(await toggleCurrentTab(deps)).toBe(false);
  });
});
