import RememberedPages, {
  MAX_ENTRIES,
  RememberedPagesDeps,
  STORAGE_KEY,
  normalizeUrl,
} from '../src/util/RememberedPages';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

const interval = { hours: 0, minutes: 0, seconds: 30, millis: 0 };
const URL1 = 'https://example.com/a?x=1';

const setup = (overrides: Partial<RememberedPagesDeps> = {}) => {
  const data: Record<string, any> = {};
  let clock = 1000;
  const query = jest.fn().mockResolvedValue([]);
  const deps = {
    storage: {
      get: jest.fn(async (key: string) => ({ [key]: data[key] })),
      set: jest.fn(async (items: Record<string, any>) => {
        Object.assign(data, items);
      }),
    },
    tabs: {
      query,
      get: jest.fn().mockResolvedValue({ url: URL1 }),
    },
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    isTabEnabled: jest.fn().mockReturnValue(false),
    enableTab: jest.fn().mockResolvedValue(undefined),
    now: () => clock++,
    ...overrides,
  };
  return { data, deps, query, pages: new RememberedPages(deps) };
};

describe('normalizeUrl', () => {
  test('strips the fragment but keeps path and query', () => {
    expect(normalizeUrl('https://example.com/a?x=1#section')).toBe(
      'https://example.com/a?x=1'
    );
  });

  test('ignores non-http(s) and invalid urls', () => {
    expect(normalizeUrl('about:blank')).toBeNull();
    expect(normalizeUrl('moz-extension://abc/index.html')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });
});

describe('RememberedPages', () => {
  test('saves interval keyed by url without fragment', async () => {
    const { data, pages } = setup();

    await pages.remember('https://example.com/a?x=1#top', interval);

    expect(Object.keys(data[STORAGE_KEY])).toEqual([URL1]);
    expect(data[STORAGE_KEY][URL1]).toMatchObject({ interval, enabled: true });
    expect(await pages.count()).toBe(1);
  });

  test('different query strings are different pages', async () => {
    const { pages } = setup();

    await pages.remember('https://example.com/a?x=1', interval);
    await pages.remember('https://example.com/a?x=2', interval);

    expect(await pages.count()).toBe(2);
  });

  test('uses storage passed in, never sync', async () => {
    const { deps, pages } = setup();
    await pages.remember(URL1, interval);
    expect(deps.storage.set).toHaveBeenCalledTimes(1);
  });

  test('forget removes one page, forgetAll removes everything', async () => {
    const { pages } = setup();
    await pages.remember('https://example.com/1', interval);
    await pages.remember('https://example.com/2', interval);

    await pages.forget('https://example.com/1#frag');
    expect(await pages.get('https://example.com/1')).toBeNull();
    expect(await pages.count()).toBe(1);

    await pages.forgetAll();
    expect(await pages.count()).toBe(0);
  });

  test('cap drops the oldest entries', async () => {
    const { data, pages } = setup();

    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await pages.remember(`https://example.com/${i}`, interval);
    }

    const keys = Object.keys(data[STORAGE_KEY]);
    expect(keys).toHaveLength(MAX_ENTRIES);
    expect(keys).not.toContain('https://example.com/0');
    expect(keys).not.toContain('https://example.com/4');
    expect(keys).toContain('https://example.com/5');
    expect(keys).toContain(`https://example.com/${MAX_ENTRIES + 4}`);
  });

  test('re-saving a page makes it the newest for the cap', async () => {
    const { data, pages } = setup();

    await pages.remember('https://example.com/first', interval);
    for (let i = 0; i < MAX_ENTRIES - 1; i++) {
      await pages.remember(`https://example.com/${i}`, interval);
    }
    await pages.remember('https://example.com/first', interval);
    await pages.remember('https://example.com/extra', interval);

    const keys = Object.keys(data[STORAGE_KEY]);
    expect(keys).toContain('https://example.com/first');
    expect(keys).not.toContain('https://example.com/0');
  });

  test('concurrent saves do not lose entries', async () => {
    const { pages } = setup();

    await Promise.all([
      pages.remember('https://example.com/1', interval),
      pages.remember('https://example.com/2', interval),
      pages.remember('https://example.com/3', interval),
    ]);

    expect(await pages.count()).toBe(3);
  });

  describe('onTabStateUpdated', () => {
    test('enable saves, interval change updates, disable forgets', async () => {
      const { pages } = setup();

      await pages.onTabStateUpdated(1, { enabled: true, interval });
      expect((await pages.get(URL1))?.interval).toEqual(interval);

      const faster = { ...interval, seconds: 10 };
      await pages.onTabStateUpdated(1, { enabled: true, interval: faster });
      expect((await pages.get(URL1))?.interval).toEqual(faster);
      expect(await pages.count()).toBe(1);

      await pages.onTabStateUpdated(1, { enabled: false, interval: faster });
      expect(await pages.count()).toBe(0);
    });

    test('does nothing when the setting is off', async () => {
      const { deps, pages } = setup({
        isFeatureEnabled: jest.fn().mockResolvedValue(false),
      });

      await pages.onTabStateUpdated(1, { enabled: true, interval });

      expect(deps.storage.set).not.toHaveBeenCalled();
      expect(await pages.count()).toBe(0);
    });

    test('ignores tabs without a rememberable url', async () => {
      const { pages } = setup({
        tabs: {
          query: jest.fn(),
          get: jest.fn().mockResolvedValue({ url: 'about:newtab' }),
        },
      });

      await pages.onTabStateUpdated(1, { enabled: true, interval });

      expect(await pages.count()).toBe(0);
    });
  });

  describe('onTabComplete', () => {
    test('enables a remembered page with the saved interval', async () => {
      const { deps, pages } = setup();
      await pages.remember(URL1, interval);

      const restored = await pages.onTabComplete(7, `${URL1}#later`);

      expect(restored).toBe(true);
      expect(deps.enableTab).toHaveBeenCalledWith(7, interval);
    });

    test('does not enable unknown pages', async () => {
      const { deps, pages } = setup();
      await pages.remember(URL1, interval);

      expect(await pages.onTabComplete(7, 'https://example.com/other')).toBe(
        false
      );
      expect(deps.enableTab).not.toHaveBeenCalled();
    });

    test('leaves an already enabled tab alone', async () => {
      const { deps, pages } = setup({
        isTabEnabled: jest.fn().mockReturnValue(true),
      });
      await pages.remember(URL1, interval);

      expect(await pages.onTabComplete(7, URL1)).toBe(false);
      expect(deps.enableTab).not.toHaveBeenCalled();
    });

    test('does not switch on a tab the caller asked to skip (paused on purpose)', async () => {
      const { deps, pages } = setup({
        shouldSkipRestore: jest.fn().mockReturnValue(true),
      });
      await pages.remember(URL1, interval);

      expect(await pages.onTabComplete(7, URL1)).toBe(false);
      expect(deps.enableTab).not.toHaveBeenCalled();
    });

    test('does nothing when the setting is off, even with saved pages', async () => {
      const isFeatureEnabled = jest.fn().mockResolvedValue(true);
      const { deps, pages } = setup({ isFeatureEnabled });
      await pages.remember(URL1, interval);
      isFeatureEnabled.mockResolvedValue(false);

      expect(await pages.onTabComplete(7, URL1)).toBe(false);
      expect(deps.enableTab).not.toHaveBeenCalled();
    });

    test('does not resume after the page was forgotten', async () => {
      const { deps, pages } = setup();
      await pages.remember(URL1, interval);
      await pages.forgetAll();

      expect(await pages.onTabComplete(7, URL1)).toBe(false);
      expect(deps.enableTab).not.toHaveBeenCalled();
    });
  });

  describe('restoreAll', () => {
    test('restores loaded tabs only, skipping discarded and loading ones', async () => {
      const { deps, query, pages } = setup();
      await pages.remember('https://example.com/a', interval);
      await pages.remember('https://example.com/b', interval);
      await pages.remember('https://example.com/c', interval);
      query.mockResolvedValue([
        { id: 1, url: 'https://example.com/a', status: 'complete' },
        {
          id: 2,
          url: 'https://example.com/b',
          status: 'complete',
          discarded: true,
        },
        { id: 3, url: 'https://example.com/c', status: 'loading' },
        { id: 4, url: 'https://example.com/zzz', status: 'complete' },
      ]);

      expect(await pages.restoreAll()).toBe(1);
      expect(deps.enableTab).toHaveBeenCalledTimes(1);
      expect(deps.enableTab).toHaveBeenCalledWith(1, interval);
    });

    test('does nothing when the setting is off', async () => {
      const { deps, pages } = setup({
        isFeatureEnabled: jest.fn().mockResolvedValue(false),
      });

      expect(await pages.restoreAll()).toBe(0);
      expect(deps.tabs.query).not.toHaveBeenCalled();
    });
  });
});

describe('defaults', () => {
  test('remembering pages is on by default', () => {
    const config = jest.requireActual('../src/config');
    expect(config.getAppDefaults().rememberPages).toBe(true);
  });
});
