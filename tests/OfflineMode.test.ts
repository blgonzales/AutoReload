import OfflineModeManager, {
  parseSavedCopy,
  describeSavedCopy,
  readStatusCode,
  OfflineStore,
  OfflineDeps,
  StorageArea,
  isEligibleUrl,
  isOfflineMessage,
  registerCode,
} from '../src/util/OfflineMode';
import {
  OFFLINE_CACHE_NAME,
  WORKER_QUERY_PARAM,
  buildWorkerScript,
  offlineStrategy,
  StrategyEnv,
} from '../src/util/OfflineWorker';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

// ---- fakes -----------------------------------------------------------

class FakeResponse {
  bodyUsed = false;
  constructor(
    public body: string,
    public status = 200,
    public type = 'basic',
    private meta: Record<string, string> = {}
  ) {
    this.headers = { get: (name: string) => this.meta[name] || null };
  }
  headers: { get: (name: string) => string | null };
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  clone() {
    if (this.bodyUsed) {
      throw new TypeError('Response.clone: Body has already been consumed.');
    }
    return new FakeResponse(this.body, this.status, this.type);
  }
  text() {
    this.bodyUsed = true;
    return Promise.resolve(this.body);
  }
}

const fakeRequest = (
  url = 'https://a.example/',
  method = 'GET',
  headers = {}
) => ({
  url,
  method,
  headers: { has: (name: string) => name in headers },
});

const setupEnv = (
  fetchImpl: (request: any) => Promise<any>,
  seeded?: Record<string, FakeResponse>
) => {
  const stored: Record<string, FakeResponse> = { ...(seeded || {}) };
  const pending: Promise<unknown>[] = [];
  const env: StrategyEnv = {
    fetch: jest.fn(fetchImpl),
    cacheName: OFFLINE_CACHE_NAME,
    caches: {
      open: async (name: string) => {
        expect(name).toBe(OFFLINE_CACHE_NAME);
        // opening a cache takes real time; the page reads the body meanwhile
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          match: async (request: any) => stored[request.url],
          put: async (request: any, response: FakeResponse) => {
            // the stored copy is read later, like a real cache would
            await Promise.resolve();
            stored[request.url] = response;
          },
        };
      },
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  return { env, stored, settle: () => Promise.all(pending) };
};

// ---- script generation -----------------------------------------------

describe('buildWorkerScript', () => {
  it.each(['networkFirst', 'staleWhileRevalidate', 'cacheFirst'])(
    'builds a script for %s',
    (mode) => {
      const script = buildWorkerScript(mode) as string;
      expect(script).toContain(`var MODE = ${JSON.stringify(mode)};`);
      expect(script).toContain(JSON.stringify(OFFLINE_CACHE_NAME));
      expect(() => new Function(script)).not.toThrow();
    }
  );

  it.each([
    'off',
    '',
    'networkfirst',
    '"; evil(); "',
    "networkFirst'; evil(); '",
    undefined,
    null,
    42,
    { toString: () => 'networkFirst' },
  ])('refuses to build a script for %p', (mode) => {
    expect(buildWorkerScript(mode)).toBeNull();
  });

  it('only embeds allow-listed text, never the input', () => {
    const script = buildWorkerScript('cacheFirst') as string;
    expect(script).not.toContain('evil');
  });

  it('generated worker answers fetch events with the chosen strategy', async () => {
    const script = buildWorkerScript('cacheFirst') as string;
    const listeners: Record<string, Function> = {};
    const cached = new FakeResponse('cached');
    const fakeSelf = {
      addEventListener: (name: string, fn: Function) => (listeners[name] = fn),
      skipWaiting: jest.fn(),
      clients: { claim: jest.fn().mockResolvedValue(undefined) },
      caches: {
        open: async () => ({ match: async () => cached, put: async () => {} }),
      },
    };
    new Function('self', 'fetch', script)(fakeSelf, jest.fn());

    listeners.install();
    expect(fakeSelf.skipWaiting).toHaveBeenCalled();

    const activate = { waitUntil: jest.fn() };
    listeners.activate(activate);
    expect(fakeSelf.clients.claim).toHaveBeenCalled();

    let answer: Promise<unknown> | undefined;
    listeners.fetch({
      request: fakeRequest(),
      respondWith: (p: Promise<unknown>) => (answer = p),
      waitUntil: jest.fn(),
    });
    expect(await answer).toBe(cached);

    answer = undefined;
    listeners.fetch({
      request: fakeRequest('https://a.example/', 'POST'),
      respondWith: (p: Promise<unknown>) => (answer = p),
    });
    expect(answer).toBeUndefined();
  });
});

// ---- strategies --------------------------------------------------------

describe('offlineStrategy', () => {
  const url = 'https://a.example/';

  describe('networkFirst', () => {
    it('stores a copy of a good response and returns it', async () => {
      const { env, stored, settle } = setupEnv(
        async () => new FakeResponse('fresh 1')
      );
      const response = await offlineStrategy(
        'networkFirst',
        fakeRequest(),
        env
      );
      expect(await response.text()).toBe('fresh 1');
      await settle();
      expect(stored[url].body).toBe('fresh 1');
    });

    it('clones before the body is consumed (regression)', async () => {
      const upstream = new FakeResponse('fresh');
      const { env, stored, settle } = setupEnv(async () => upstream);
      const response = await offlineStrategy(
        'networkFirst',
        fakeRequest(),
        env
      );
      // the page starts reading immediately; a late clone() would throw
      await response.text();
      await settle();
      expect(stored[url]).toBeDefined();
      expect(stored[url].body).toBe('fresh');
    });

    it('serves the cached copy when the network fails', async () => {
      const copy = new FakeResponse('old');
      const { env } = setupEnv(() => Promise.reject(new TypeError('offline')), {
        [url]: copy,
      });
      expect(await offlineStrategy('networkFirst', fakeRequest(), env)).toBe(
        copy
      );
    });

    it('rethrows the network error when nothing is cached', async () => {
      const { env } = setupEnv(() => Promise.reject(new TypeError('offline')));
      await expect(
        offlineStrategy('networkFirst', fakeRequest(), env)
      ).rejects.toThrow('offline');
    });

    it.each([502, 503, 504, 520, 521, 522, 523, 524])(
      'serves the cached copy on %i',
      async (status) => {
        const copy = new FakeResponse('old');
        const { env } = setupEnv(async () => new FakeResponse('err', status), {
          [url]: copy,
        });
        expect(await offlineStrategy('networkFirst', fakeRequest(), env)).toBe(
          copy
        );
      }
    );

    it('passes a 5xx through when nothing is cached, and does not cache it', async () => {
      const error = new FakeResponse('err', 504);
      const { env, stored, settle } = setupEnv(async () => error);
      expect(await offlineStrategy('networkFirst', fakeRequest(), env)).toBe(
        error
      );
      await settle();
      expect(stored[url]).toBeUndefined();
    });

    it('passes other statuses (404, 500) through untouched', async () => {
      const copy = new FakeResponse('old');
      const missing = new FakeResponse('nope', 404);
      const { env } = setupEnv(async () => missing, { [url]: copy });
      expect(await offlineStrategy('networkFirst', fakeRequest(), env)).toBe(
        missing
      );
    });

    it('does not cache opaque or opaque-redirect responses', async () => {
      const opaque = new FakeResponse('', 0, 'opaque');
      const { env, stored, settle } = setupEnv(async () => opaque);
      expect(await offlineStrategy('networkFirst', fakeRequest(), env)).toBe(
        opaque
      );
      await settle();
      expect(stored[url]).toBeUndefined();
    });

    it('caches cors responses', async () => {
      const { env, stored, settle } = setupEnv(
        async () => new FakeResponse('x', 200, 'cors')
      );
      await offlineStrategy('networkFirst', fakeRequest(), env);
      await settle();
      expect(stored[url]).toBeDefined();
    });
  });

  describe('staleWhileRevalidate', () => {
    it('serves the cache and refreshes it in the background', async () => {
      const old = new FakeResponse('old');
      const { env, stored, settle } = setupEnv(
        async () => new FakeResponse('new'),
        {
          [url]: old,
        }
      );
      const response = await offlineStrategy(
        'staleWhileRevalidate',
        fakeRequest(),
        env
      );
      expect(response).toBe(old);
      await settle();
      expect(stored[url].body).toBe('new');
    });

    it('survives a failing background update', async () => {
      const old = new FakeResponse('old');
      const { env, settle } = setupEnv(
        () => Promise.reject(new Error('down')),
        {
          [url]: old,
        }
      );
      expect(
        await offlineStrategy('staleWhileRevalidate', fakeRequest(), env)
      ).toBe(old);
      await expect(settle()).resolves.toBeDefined();
    });

    it('goes to the network (and stores) without a cached copy', async () => {
      const { env, stored, settle } = setupEnv(
        async () => new FakeResponse('first')
      );
      const response = await offlineStrategy(
        'staleWhileRevalidate',
        fakeRequest(),
        env
      );
      expect(await response.text()).toBe('first');
      await settle();
      expect(stored[url].body).toBe('first');
    });
  });

  describe('cacheFirst', () => {
    it('never touches the network when a copy exists', async () => {
      const old = new FakeResponse('old');
      const { env } = setupEnv(async () => new FakeResponse('new'), {
        [url]: old,
      });
      expect(await offlineStrategy('cacheFirst', fakeRequest(), env)).toBe(old);
      expect(env.fetch).not.toHaveBeenCalled();
    });

    it('fetches and stores when nothing is cached', async () => {
      const { env, stored, settle } = setupEnv(
        async () => new FakeResponse('first')
      );
      const response = await offlineStrategy('cacheFirst', fakeRequest(), env);
      expect(await response.text()).toBe('first');
      await settle();
      expect(stored[url].body).toBe('first');
    });
  });

  it('leaves non-GET and range requests alone', async () => {
    const post = fakeRequest(url, 'POST');
    const range = fakeRequest(url, 'GET', { range: 'bytes=0-1' });
    for (const request of [post, range]) {
      const { env } = setupEnv(async () => new FakeResponse('x'), {
        [url]: new FakeResponse('cached'),
      });
      const response = await offlineStrategy('cacheFirst', request, env);
      expect(response.body).toBe('x');
      expect(env.fetch).toHaveBeenCalledWith(request);
    }
  });

  it('goes straight to the network for an unknown mode', async () => {
    const { env } = setupEnv(async () => new FakeResponse('x'));
    const response = await offlineStrategy('bogus', fakeRequest(), env);
    expect(response.body).toBe('x');
  });
});

// ---- store -------------------------------------------------------------

const memoryArea = (initial: Record<string, any> = {}) => {
  const data: Record<string, any> = { ...initial };
  const area: StorageArea = {
    get: async () => ({ ...data }),
    set: async (items) => {
      Object.assign(data, items);
    },
    remove: async (key) => {
      delete data[key];
    },
  };
  return { data, area };
};

describe('OfflineStore', () => {
  it('keeps one entry per host and reuses the token', async () => {
    const { data, area } = memoryArea();
    let n = 0;
    const store = new OfflineStore(area, () => `token${++n}`);
    const first = await store.setMode('https://a.example', 'networkFirst');
    const second = await store.setMode('https://a.example', 'cacheFirst');
    await store.setMode('https://b.example', 'networkFirst');
    expect(first.token).toBe('token1');
    expect(second.token).toBe('token1');
    expect(store.get('https://b.example')?.token).toBe('token2');
    expect(Object.keys(data).sort()).toEqual([
      'offline:https://a.example',
      'offline:https://b.example',
    ]);
    expect(data['offline:https://a.example']).toEqual({
      mode: 'cacheFirst',
      token: 'token1',
    });
  });

  it('loads saved prefs and ignores unrelated or malformed entries', async () => {
    const { area } = memoryArea({
      'offline:https://a.example': { mode: 'networkFirst', token: 't' },
      'offline:https://b.example': { mode: 'evil', token: 't' },
      'offline:https://c.example': { mode: 'cacheFirst' },
      settings: { mode: 'networkFirst', token: 't' },
    });
    const store = new OfflineStore(area, () => 'x');
    await store.ready();
    expect(store.origins()).toEqual(['https://a.example']);
  });

  it('marks an off host for cleanup and can forget it', async () => {
    const { data, area } = memoryArea();
    const store = new OfflineStore(area, () => 't');
    await store.setMode('https://a.example', 'cacheFirst');
    await store.setMode('https://a.example', 'off');
    expect(store.get('https://a.example')).toEqual({
      mode: 'off',
      token: 't',
      cleanup: true,
    });
    await store.delete('https://a.example');
    expect(store.get('https://a.example')).toBeUndefined();
    expect(data).toEqual({});
  });
});

// ---- manager -----------------------------------------------------------

const setupManager = (tabs: any[], executeResult: any = ['ok']) => {
  const { data, area } = memoryArea();
  const store = new OfflineStore(area, () => 'tok');
  const executeScript = jest.fn().mockResolvedValue(executeResult);
  const deps: OfflineDeps = {
    store,
    executeScript,
    queryTabs: async () => tabs,
  };
  return { manager: new OfflineModeManager(deps), store, executeScript, data };
};

const tab = (id: number, url: string, incognito = false) => ({
  id,
  url,
  incognito,
});

describe('OfflineModeManager', () => {
  it('registers the worker in open tabs of the host when a mode is chosen', async () => {
    const { manager, executeScript } = setupManager([
      tab(1, 'https://a.example/x'),
      tab(2, 'https://b.example/'),
      tab(3, 'https://a.example/private', true),
      tab(4, 'http://a.example/insecure'),
    ]);
    const state = await manager.setMode('https://a.example', 'networkFirst');
    expect(state).toEqual({ mode: 'networkFirst', status: 'active' });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(1, registerCode('tok', true));
  });

  it('rejects unknown modes without touching storage', async () => {
    const { manager, data, executeScript } = setupManager([]);
    const state = await manager.setMode('https://a.example', '"; evil()');
    expect(state.mode).toBe('off');
    expect(data).toEqual({});
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('turning off unregisters, clears the cache and forgets the host', async () => {
    const { manager, store, executeScript } = setupManager([
      tab(1, 'https://a.example/'),
    ]);
    await manager.setMode('https://a.example', 'cacheFirst');
    executeScript.mockClear();
    await manager.setMode('https://a.example', 'off');
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0][1]).toContain('getRegistrations');
    expect(executeScript.mock.calls[1][1]).toContain('caches.delete');
    expect(store.get('https://a.example')).toBeUndefined();
  });

  it('unregisters on the next visit when no tab was open at turn-off', async () => {
    const tabs: any[] = [];
    const { manager, store, executeScript } = setupManager(tabs);
    await manager.setMode('https://a.example', 'cacheFirst');
    await manager.setMode('https://a.example', 'off');
    expect(store.get('https://a.example')?.cleanup).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();

    const visit = tab(7, 'https://a.example/');
    tabs.push(visit);
    await manager.onTabComplete(visit);
    expect(executeScript.mock.calls[0][1]).toContain('getRegistrations');
    expect(store.get('https://a.example')).toBeUndefined();
  });

  it('registers on page load only for enabled, eligible, non-private tabs', async () => {
    const { manager, executeScript } = setupManager([]);
    await manager.setMode('https://a.example', 'networkFirst');
    await manager.onTabComplete(tab(1, 'https://a.example/'));
    await manager.onTabComplete(tab(2, 'https://other.example/'));
    await manager.onTabComplete(tab(3, 'https://a.example/', true));
    await manager.onTabComplete(tab(4, 'about:blank'));
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(1, registerCode('tok', false));
  });

  it('clears saved copies via the page', async () => {
    const { manager, executeScript } = setupManager(
      [tab(1, 'https://a.example/')],
      [true]
    );
    expect(await manager.clearCopies('https://a.example')).toBe(1);
    expect(executeScript.mock.calls[0][1]).toContain(
      JSON.stringify(OFFLINE_CACHE_NAME)
    );
  });

  it('reports a failed registration (e.g. blocked by CSP)', async () => {
    const { manager } = setupManager(
      [tab(1, 'https://a.example/')],
      ['error: The operation is insecure.']
    );
    const state = await manager.setMode('https://a.example', 'networkFirst');
    expect(state.status).toBe('error: The operation is insecure.');
  });

  describe('workerScriptFor (spoof protection)', () => {
    const request = async () => {
      const ctx = setupManager([]);
      await ctx.manager.setMode('https://a.example', 'networkFirst');
      return ctx.manager;
    };
    const good = `https://a.example/?${WORKER_QUERY_PARAM}=tok`;

    it('serves the script for the right token', async () => {
      const manager = await request();
      expect(manager.workerScriptFor(good, 'GET')).toContain('networkFirst');
    });

    it.each([
      ['wrong token', `https://a.example/?${WORKER_QUERY_PARAM}=nope`],
      ['empty token', `https://a.example/?${WORKER_QUERY_PARAM}=`],
      ['other host', `https://b.example/?${WORKER_QUERY_PARAM}=tok`],
      ['other path', `https://a.example/x?${WORKER_QUERY_PARAM}=tok`],
      ['no param', 'https://a.example/'],
      ['garbage', 'not a url'],
    ])('serves nothing for %s', async (_name, url) => {
      const manager = await request();
      expect(manager.workerScriptFor(url, 'GET')).toBeNull();
    });

    it('serves nothing for non-GET requests or a host that is off', async () => {
      const manager = await request();
      expect(manager.workerScriptFor(good, 'POST')).toBeNull();
      await manager.setMode('https://a.example', 'off');
      expect(manager.workerScriptFor(good, 'GET')).toBeNull();
    });
  });
});

// ---- indicator: what a navigation was answered with ----------------------

describe('navigation reports', () => {
  const url = 'https://a.example/';
  const navigation = () => ({ ...fakeRequest(), mode: 'navigate' });
  const saved = (savedAt = 1700000000000) =>
    new FakeResponse('old', 200, 'basic', {
      'x-autoreload-saved-at': String(savedAt),
    });

  const withReport = (
    fetchImpl: (request: any) => Promise<any>,
    seeded?: Record<string, FakeResponse>
  ) => {
    const ctx = setupEnv(fetchImpl, seeded);
    const report = jest.fn().mockResolvedValue(undefined);
    ctx.env.report = report;
    return { ...ctx, report };
  };

  it('reports an unreachable site with the time the copy was saved', async () => {
    const { env, report } = withReport(
      () => Promise.reject(new TypeError('x')),
      {
        [url]: saved(),
      }
    );
    await offlineStrategy('networkFirst', navigation(), env);
    expect(report).toHaveBeenCalledWith(expect.anything(), {
      reason: 'unreachable',
      savedAt: 1700000000000,
    });
  });

  it('reports the status code of a failing site', async () => {
    const { env, report } = withReport(async () => new FakeResponse('e', 504), {
      [url]: saved(),
    });
    await offlineStrategy('networkFirst', navigation(), env);
    expect(report.mock.calls[0][1]).toEqual({
      reason: 504,
      savedAt: 1700000000000,
    });
  });

  it('reports a live response, so the badge clears', async () => {
    const { env, report } = withReport(async () => new FakeResponse('fresh'), {
      [url]: saved(),
    });
    await offlineStrategy('networkFirst', navigation(), env);
    expect(report.mock.calls[0][1]).toEqual({ reason: null, savedAt: null });
  });

  it('reports a 504 with nothing saved as live (nothing to flag)', async () => {
    const { env, report } = withReport(async () => new FakeResponse('e', 504));
    await offlineStrategy('networkFirst', navigation(), env);
    expect(report.mock.calls[0][1].reason).toBeNull();
  });

  it.each(['cacheFirst', 'staleWhileRevalidate'])(
    '%s serving from the cache is reported as a saved copy',
    async (mode) => {
      const { env, report } = withReport(async () => new FakeResponse('n'), {
        [url]: saved(),
      });
      await offlineStrategy(mode, navigation(), env);
      expect(report.mock.calls[0][1]).toEqual({
        reason: 'notChecked',
        savedAt: 1700000000000,
      });
    }
  );

  it('does not report subresource requests', async () => {
    const { env, report } = withReport(
      () => Promise.reject(new TypeError('x')),
      {
        [url]: saved(),
      }
    );
    await offlineStrategy(
      'networkFirst',
      { ...fakeRequest(), mode: 'cors' },
      env
    );
    expect(report).not.toHaveBeenCalled();
  });

  it('still answers when reporting fails', async () => {
    const copy = saved();
    const { env, report } = withReport(
      () => Promise.reject(new TypeError('x')),
      {
        [url]: copy,
      }
    );
    report.mockRejectedValue(new Error('quota'));
    expect(await offlineStrategy('networkFirst', navigation(), env)).toBe(copy);
  });

  it('stamps copies it stores', async () => {
    const { env, stored, settle } = setupEnv(
      async () => new FakeResponse('fresh')
    );
    env.stamp = (response) =>
      new FakeResponse(response.body, 200, 'basic', { stamped: '1' });
    await offlineStrategy('networkFirst', fakeRequest(), env);
    await settle();
    expect(stored[url].headers.get('stamped')).toBe('1');
  });

  it('the generated worker defines stamp and report with constant text only', () => {
    const script = buildWorkerScript('networkFirst') as string;
    expect(script).toContain('x-autoreload-saved-at');
    expect(script).toContain('/__autoreload-offline-status');
    expect(script).toContain('stamp: stamp');
    expect(script).toContain('report: report');
  });
});

describe('toolbar indicator', () => {
  const at = Date.now() - 3600 * 1000;
  const hhmm = [new Date(at).getHours(), new Date(at).getMinutes()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

  it('describes the reason and the time', () => {
    expect(describeSavedCopy({ reason: 504, savedAt: at })).toEqual({
      text: 'OLD',
      title: `AutoReload: showing saved copy from ${hhmm} (site returned 504)`,
    });
    expect(
      describeSavedCopy({ reason: 'unreachable', savedAt: at }).title
    ).toBe(`AutoReload: showing saved copy from ${hhmm} (site unreachable)`);
    expect(
      describeSavedCopy({ reason: 'notChecked', savedAt: null }).title
    ).toBe('AutoReload: showing saved copy (not checked with the site)');
  });

  const setup = (result: any) => {
    const ctx = setupManager([], [result]);
    const setIndicator = jest.fn();
    (ctx.manager.deps as any).setIndicator = setIndicator;
    return { ...ctx, setIndicator };
  };

  it('sets the badge when the page is a saved copy, clears it when live', async () => {
    const info = { reason: 'unreachable' as const, savedAt: at };
    const { manager, setIndicator, executeScript } = setup(info);
    await manager.setMode('https://a.example', 'networkFirst');
    await manager.onTabComplete(tab(1, 'https://a.example/'));
    expect(setIndicator).toHaveBeenLastCalledWith(1, describeSavedCopy(info));

    executeScript.mockResolvedValue([null]);
    await manager.onTabComplete(tab(1, 'https://a.example/'));
    expect(setIndicator).toHaveBeenLastCalledWith(1, null);
    expect(setIndicator).toHaveBeenCalledTimes(2);
  });

  it('does not touch tabs that never had a badge', async () => {
    const { manager, setIndicator } = setup(null);
    await manager.setMode('https://a.example', 'networkFirst');
    await manager.onTabComplete(tab(1, 'https://a.example/'));
    await manager.onTabComplete(tab(2, 'https://other.example/'));
    expect(setIndicator).not.toHaveBeenCalled();
  });

  it('clears the badge when the tab moves to a site without offline mode', async () => {
    const info = { reason: 503, savedAt: at };
    const { manager, setIndicator } = setup(info);
    await manager.setMode('https://a.example', 'networkFirst');
    await manager.onTabComplete(tab(1, 'https://a.example/'));
    await manager.onTabComplete(tab(1, 'https://other.example/'));
    expect(setIndicator).toHaveBeenLastCalledWith(1, null);
  });

  describe('the saved-copy record is untrusted (the page can write it)', () => {
    const now = Date.now();

    it.each([
      [{ reason: 'unreachable', savedAt: now - 1000 }],
      [{ reason: 'notChecked', savedAt: null }],
      [{ reason: 504, savedAt: now }],
      [{ reason: 523, savedAt: now - 364 * 24 * 3600 * 1000 }],
      [{ reason: 502, savedAt: now + 60 * 1000 }],
    ])('accepts %j', (raw) => {
      expect(parseSavedCopy(raw, now)).not.toBeNull();
    });

    it.each([
      [
        'arbitrary text',
        { reason: 'Your Firefox is infected, call 555', savedAt: now },
      ],
      ['HTML', { reason: '<img src=x onerror=alert(1)>', savedAt: now }],
      ['very long text', { reason: 'x'.repeat(100000), savedAt: now }],
      ['old format', { reason: 'status 504', savedAt: now }],
      ['status 200', { reason: 200, savedAt: now }],
      ['status 404', { reason: 404, savedAt: now }],
      ['numeric string', { reason: '504', savedAt: now }],
      ['fractional status', { reason: 504.5, savedAt: now }],
      ['no reason', { savedAt: now }],
      ['null reason', { reason: null, savedAt: now }],
      ['string time', { reason: 504, savedAt: String(now) }],
      ['NaN time', { reason: 504, savedAt: NaN }],
      ['Infinity time', { reason: 504, savedAt: Infinity }],
      ['huge time', { reason: 504, savedAt: 1e300 }],
      ['negative time', { reason: 504, savedAt: -5 }],
      [
        'older than a year',
        { reason: 504, savedAt: now - 366 * 24 * 3600 * 1000 },
      ],
      ['in the future', { reason: 504, savedAt: now + 10 * 60 * 1000 }],
      ['object time', { reason: 504, savedAt: { valueOf: () => now } }],
      ['not an object', 'unreachable'],
      ['null', null],
    ])('rejects %s', (_name, raw) => {
      expect(parseSavedCopy(raw, now)).toBeNull();
    });

    it('shows no badge for a forged record', async () => {
      const { manager, setIndicator } = setup({
        reason: 'Warning: call us',
        savedAt: Date.now(),
      });
      await manager.setMode('https://a.example', 'networkFirst');
      await manager.onTabComplete(tab(1, 'https://a.example/'));
      expect(setIndicator).not.toHaveBeenCalled();
    });

    it('builds the tooltip only from fixed text, the time and the status', () => {
      const title = describeSavedCopy(
        parseSavedCopy({ reason: 503, savedAt: now }, now) as any
      ).title;
      expect(title).toMatch(
        /^AutoReload: showing saved copy from \d\d:\d\d \(site returned 503\)$/
      );
    });
  });

  it('every status the worker falls back on is accepted by the validator', async () => {
    for (const status of [502, 503, 504, 520, 521, 522, 523, 524]) {
      const copy = new FakeResponse('old', 200, 'basic', {
        'x-autoreload-saved-at': String(Date.now()),
      });
      const { env, stored } = setupEnv(
        async () => new FakeResponse('e', status),
        {
          'https://a.example/': copy,
        }
      );
      const report = jest.fn().mockResolvedValue(undefined);
      env.report = report;
      expect(stored).toBeDefined();
      await offlineStrategy(
        'networkFirst',
        { ...fakeRequest(), mode: 'navigate' },
        env
      );
      expect(parseSavedCopy(report.mock.calls[0][1])).not.toBeNull();
      expect(report.mock.calls[0][1].reason).toBe(status);
    }
  });

  it('the in-page query only trusts records written during this load', () => {
    const code = readStatusCode();
    expect(code).toContain('serviceWorker.controller');
    expect(code).toContain('timeOrigin');
  });
});

// ---- origin scoping --------------------------------------------------------

describe('origins are independent', () => {
  const setupTwo = (tabs: any[]) => {
    const { data, area } = memoryArea();
    let n = 0;
    const store = new OfflineStore(area, () => `tok${++n}`);
    const executeScript = jest.fn().mockResolvedValue(['ok']);
    const manager = new OfflineModeManager({
      store,
      executeScript,
      queryTabs: async () => tabs,
    });
    return { manager, store, executeScript, data };
  };

  it.each([
    ['another port', 'https://a.example:8443/'],
    ['another port on localhost', 'http://localhost:3000/'],
    ['another scheme on the same host', 'https://localhost:8080/'],
  ])('enabling one origin never registers on %s', async (_name, other) => {
    const base = other.startsWith('https://a.example')
      ? 'https://a.example'
      : 'http://localhost:8080';
    const tabs = [tab(1, base + '/'), tab(2, other)];
    const { manager, executeScript } = setupTwo(tabs);
    await manager.setMode(base, 'networkFirst');
    expect(executeScript.mock.calls.map((c) => c[0])).toEqual([1]);

    executeScript.mockClear();
    await manager.onTabComplete(tabs[1]);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('keeps one token, mode and storage key per origin', async () => {
    const { manager, store, data } = setupTwo([]);
    await manager.setMode('https://a.example', 'networkFirst');
    await manager.setMode('https://a.example:8443', 'cacheFirst');
    expect(Object.keys(data).sort()).toEqual([
      'offline:https://a.example',
      'offline:https://a.example:8443',
    ]);
    expect(store.get('https://a.example')?.token).toBe('tok1');
    expect(store.get('https://a.example:8443')?.token).toBe('tok2');
  });

  it('a worker request for one origin is not answered for another', async () => {
    const { manager } = setupTwo([]);
    await manager.setMode('https://a.example', 'networkFirst');
    const q = `?${WORKER_QUERY_PARAM}=tok1`;
    expect(
      manager.workerScriptFor(`https://a.example/${q}`, 'GET')
    ).not.toBeNull();
    expect(
      manager.workerScriptFor(`https://a.example:8443/${q}`, 'GET')
    ).toBeNull();
    expect(manager.workerScriptFor(`http://a.example/${q}`, 'GET')).toBeNull();
  });

  it('turning one origin off leaves the other on', async () => {
    const tabs = [tab(1, 'http://localhost:1/'), tab(2, 'http://localhost:2/')];
    const { manager, store } = setupTwo(tabs);
    await manager.setMode('http://localhost:1', 'cacheFirst');
    await manager.setMode('http://localhost:2', 'cacheFirst');
    await manager.setMode('http://localhost:1', 'off');
    expect(store.get('http://localhost:1')).toBeUndefined();
    expect(store.get('http://localhost:2')?.mode).toBe('cacheFirst');
  });

  it('pending cleanup is per origin', async () => {
    const { manager, store, executeScript } = setupTwo([]);
    await manager.setMode('https://a.example', 'cacheFirst');
    await manager.setMode('https://a.example', 'off');
    expect(store.get('https://a.example')?.cleanup).toBe(true);
    await manager.onTabComplete(tab(5, 'https://a.example:8443/'));
    expect(executeScript).not.toHaveBeenCalled();
    expect(store.get('https://a.example')?.cleanup).toBe(true);
  });
});

describe('helpers', () => {
  it('only treats https and localhost http as eligible', () => {
    expect(isEligibleUrl('https://a.example/')).toBe(true);
    expect(isEligibleUrl('http://localhost:8080/')).toBe(true);
    expect(isEligibleUrl('http://127.0.0.1/')).toBe(true);
    expect(isEligibleUrl('http://app.localhost/')).toBe(true);
    expect(isEligibleUrl('http://a.example/')).toBe(false);
    expect(isEligibleUrl('about:blank')).toBe(false);
    expect(isEligibleUrl('moz-extension://x/index.html')).toBe(false);
    expect(isEligibleUrl(undefined)).toBe(false);
  });

  it('recognises offline messages only', () => {
    expect(isOfflineMessage({ type: 'offline:get', origin: 'a' })).toBe(true);
    expect(isOfflineMessage({ type: 'getTabState' })).toBe(false);
    expect(isOfflineMessage(undefined)).toBe(false);
  });

  it('interpolates tokens through JSON.stringify', () => {
    const code = registerCode('a"b', false);
    expect(code).toContain(JSON.stringify(`/?${WORKER_QUERY_PARAM}=a%22b`));
  });
});
