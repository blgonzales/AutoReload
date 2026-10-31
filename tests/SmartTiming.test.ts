import SmartTiming, {
  OWN_RELOAD_WINDOW_MS,
  SmartTimingDeps,
  SmartTimingOptions,
} from '../src/util/SmartTiming';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

const setup = (
  options: Partial<SmartTimingOptions> = {},
  status: string | undefined = 'complete'
) => {
  let time = 1000;
  const deps = {
    getOptions: jest.fn().mockResolvedValue({
      skipWhileLoading: false,
      restartOnManualLoad: false,
      ...options,
    }),
    getTabStatus: jest.fn().mockResolvedValue(status),
    restartTimer: jest.fn(),
    now: () => time,
  } satisfies SmartTimingDeps;
  return {
    deps,
    smart: new SmartTiming(deps),
    advance: (ms: number) => {
      time += ms;
    },
  };
};

describe('SmartTiming.shouldReload', () => {
  test('always reloads when the option is off, without asking the tab', async () => {
    const { smart, deps } = setup({}, 'loading');
    expect(await smart.shouldReload(1)).toBe(true);
    expect(deps.getTabStatus).not.toHaveBeenCalled();
  });

  test('skips when the option is on and the tab is loading', async () => {
    const { smart } = setup({ skipWhileLoading: true }, 'loading');
    expect(await smart.shouldReload(1)).toBe(false);
  });

  test('reloads when the option is on and the tab is complete', async () => {
    const { smart, deps } = setup({ skipWhileLoading: true }, 'complete');
    expect(await smart.shouldReload(7)).toBe(true);
    expect(deps.getTabStatus).toHaveBeenCalledWith(7);
  });

  test('reloads when the status is unknown', async () => {
    const { smart } = setup({ skipWhileLoading: true }, undefined);
    expect(await smart.shouldReload(1)).toBe(true);
  });
});

describe('SmartTiming.onTabLoading', () => {
  test('does nothing when the option is off', async () => {
    const { smart, deps } = setup();
    await smart.onTabLoading(1);
    expect(deps.restartTimer).not.toHaveBeenCalled();
  });

  test('restarts the timer for a load AutoReload did not start', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: true });
    await smart.onTabLoading(3);
    expect(deps.restartTimer).toHaveBeenCalledWith(3);
  });

  test('ignores the loading event of its own reload', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1);
    await smart.onTabLoading(1);
    expect(deps.restartTimer).not.toHaveBeenCalled();
  });

  test('own reload on one tab does not hide a manual load on another', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1);
    await smart.onTabLoading(2);
    expect(deps.restartTimer).toHaveBeenCalledWith(2);
  });

  test('race: user reloads right after AutoReload did', async () => {
    const { smart, deps, advance } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1);
    await smart.onTabLoading(1); // AutoReload's own load
    advance(300);
    await smart.onTabLoading(1); // the user's reload
    expect(deps.restartTimer).toHaveBeenCalledTimes(1);
    expect(deps.restartTimer).toHaveBeenCalledWith(1);
  });

  test('each own reload is consumed once', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1);
    await smart.onTabLoading(1);
    smart.markOwnReload(1);
    await smart.onTabLoading(1);
    expect(deps.restartTimer).not.toHaveBeenCalled();
  });

  test('a stale expectation expires so a later manual load still counts', async () => {
    const { smart, deps, advance } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1); // never produced a loading event
    advance(OWN_RELOAD_WINDOW_MS + 1);
    await smart.onTabLoading(1);
    expect(deps.restartTimer).toHaveBeenCalledWith(1);
  });

  test('a failed reload does not swallow the next manual load', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1);
    smart.cancelOwnReload(1);
    await smart.onTabLoading(1);
    expect(deps.restartTimer).toHaveBeenCalledWith(1);
  });

  test('forget drops the expectation of a closed tab', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: true });
    smart.markOwnReload(1);
    smart.forget(1);
    await smart.onTabLoading(1);
    expect(deps.restartTimer).toHaveBeenCalledWith(1);
  });

  test('consumes the flag even when the option is off', async () => {
    const { smart, deps } = setup({ restartOnManualLoad: false });
    smart.markOwnReload(1);
    await smart.onTabLoading(1);
    expect(deps.restartTimer).not.toHaveBeenCalled();
  });
});
