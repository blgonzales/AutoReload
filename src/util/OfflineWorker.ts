// Pure logic for "Offline mode": the generated service worker script and the
// caching strategies it runs. Nothing here touches browser APIs, so it can be
// tested with fake fetch/caches objects.

// Reserved query parameter on the site's own origin. A request carrying the
// right per-site token is answered with the generated worker script.
export const WORKER_QUERY_PARAM = 'autoreload-offline-sw';

// Name of the cache in the site's own Cache Storage.
export const OFFLINE_CACHE_NAME = 'autoreload-offline';

// The only modes a worker script can be generated for.
export const OFFLINE_MODES = [
  'networkFirst',
  'staleWhileRevalidate',
  'cacheFirst',
] as const;

export type OfflineMode = (typeof OFFLINE_MODES)[number];

export const isOfflineMode = (mode: unknown): mode is OfflineMode =>
  typeof mode === 'string' && OFFLINE_MODES.some((known) => known === mode);

// Header added to every saved copy: when it was saved (ms since epoch).
export const SAVED_AT_HEADER = 'x-autoreload-saved-at';

// Key prefix, inside the same cache, of the small record the worker leaves
// for the add-on about the last navigation it answered.
export const STATUS_KEY_PATH = '/__autoreload-offline-status';

// Statuses the worker hides behind a saved copy (also the only ones the
// add-on accepts back in a record).
export const FALLBACK_STATUSES = [502, 503, 504, 520, 521, 522, 523, 524];

export type ServedInfo = {
  // 'unreachable', 'notChecked' (cache first / stale while revalidate), the
  // HTTP status of a failing site (a number), or null when the response was
  // live
  reason: string | number | null;
  savedAt: number | null;
};

export type StrategyEnv = {
  fetch: (request: any) => Promise<any>;
  caches: { open: (name: string) => Promise<any> };
  cacheName: string;
  waitUntil?: (promise: Promise<unknown>) => void;
  // add the saved-at header to a response about to be stored
  stamp?: (response: any) => any;
  // record what a navigation was answered with (only called for navigations)
  report?: (request: any, info: ServedInfo) => Promise<unknown>;
};

// Runs inside the service worker: its source text is embedded in the
// generated script with Function.prototype.toString(). It therefore has to be
// fully self-contained (no module-level helpers, no async/await or object
// spread, which the compiler would turn into helper calls).
export function offlineStrategy(
  mode: string,
  request: any,
  env: StrategyEnv
): Promise<any> {
  // gateway and origin errors worth hiding behind the last good copy
  const SERVER_ERRORS = [502, 503, 504, 520, 521, 522, 523, 524];
  const keepAlive = (promise: Promise<unknown>) => {
    if (env.waitUntil) {
      env.waitUntil(promise);
    }
  };

  if (
    request.method !== 'GET' ||
    (request.headers && request.headers.has('range'))
  ) {
    return env.fetch(request);
  }

  const lookup = () =>
    env.caches
      .open(env.cacheName)
      .then((cache: any) => cache.match(request, { ignoreVary: true }))
      .catch(() => undefined);

  const cacheable = (response: any) =>
    !!response &&
    response.ok &&
    (response.type === 'basic' || response.type === 'cors');

  const savedAtOf = (cached: any) => {
    const value =
      cached && cached.headers && cached.headers.get
        ? cached.headers.get('x-autoreload-saved-at')
        : null;
    return value ? Number(value) : null;
  };

  const isNavigation = request.mode === 'navigate';

  // tell the add-on what this navigation was answered with, then answer it
  const answer = (
    response: any,
    reason: string | number | null,
    cached?: any
  ) => {
    if (!isNavigation || !env.report) {
      return response;
    }
    return env
      .report(request, {
        reason: reason,
        savedAt: reason ? savedAtOf(cached) : null,
      })
      .catch(() => undefined)
      .then(() => response);
  };

  // The copy MUST be taken now, synchronously, while the body is unused:
  // once the page starts reading the response, clone() throws.
  const save = (response: any) => {
    const copy = response.clone();
    const stored = env.stamp ? env.stamp(copy) : copy;
    keepAlive(
      env.caches
        .open(env.cacheName)
        .then((cache: any) => cache.put(request, stored))
        .catch(() => undefined)
    );
  };

  if (mode === 'networkFirst') {
    return env.fetch(request).then(
      (response: any) => {
        if (cacheable(response)) {
          save(response);
          return answer(response, null);
        }
        if (SERVER_ERRORS.indexOf(response.status) !== -1) {
          return lookup().then((cached: any) =>
            cached
              ? answer(cached, response.status, cached)
              : answer(response, null)
          );
        }
        return answer(response, null);
      },
      (error: any) =>
        lookup().then((cached: any) => {
          if (cached) {
            return answer(cached, 'unreachable', cached);
          }
          throw error;
        })
    );
  }

  if (mode === 'staleWhileRevalidate') {
    return lookup().then((cached: any) => {
      const network = env.fetch(request).then((response: any) => {
        if (cacheable(response)) {
          save(response);
        }
        return response;
      });
      if (cached) {
        keepAlive(network.catch(() => undefined));
        return answer(cached, 'notChecked', cached);
      }
      return network.then((response: any) => answer(response, null));
    });
  }

  if (mode === 'cacheFirst') {
    return lookup().then((cached: any) => {
      if (cached) {
        return answer(cached, 'notChecked', cached);
      }
      return env.fetch(request).then((response: any) => {
        if (cacheable(response)) {
          save(response);
        }
        return answer(response, null);
      });
    });
  }

  return env.fetch(request);
}

// Builds the service worker source for a mode. Returns null for anything that
// is not on the allow-list; the only values placed in the text are the
// allow-listed mode and a constant, both through JSON.stringify.
export const buildWorkerScript = (mode: unknown): string | null => {
  const known = OFFLINE_MODES.find((candidate) => candidate === mode);
  if (!known) {
    return null;
  }

  return [
    '// Generated by the AutoReload add-on (offline mode). Do not edit.',
    `var MODE = ${JSON.stringify(known)};`,
    `var CACHE_NAME = ${JSON.stringify(OFFLINE_CACHE_NAME)};`,
    `var SAVED_AT_HEADER = ${JSON.stringify(SAVED_AT_HEADER)};`,
    `var STATUS_KEY_PATH = ${JSON.stringify(STATUS_KEY_PATH)};`,
    `var strategy = (${offlineStrategy.toString()});`,
    'function stamp(response) {',
    '  var headers = new Headers(response.headers);',
    '  headers.set(SAVED_AT_HEADER, String(Date.now()));',
    '  return new Response(response.body, {',
    '    status: response.status,',
    '    statusText: response.statusText,',
    '    headers: headers',
    '  });',
    '}',
    'function report(request, info) {',
    '  var key = STATUS_KEY_PATH + "?u=" + encodeURIComponent(request.url.split("#")[0]);',
    '  return caches.open(CACHE_NAME).then(function (cache) {',
    '    if (!info.reason) { return cache.delete(key); }',
    '    return cache.put(key, new Response(JSON.stringify({',
    '      reason: info.reason, savedAt: info.savedAt, at: Date.now()',
    '    })));',
    '  });',
    '}',
    "self.addEventListener('install', function () { self.skipWaiting(); });",
    "self.addEventListener('activate', function (event) {",
    '  event.waitUntil(self.clients.claim());',
    '});',
    "self.addEventListener('fetch', function (event) {",
    "  if (event.request.method !== 'GET') { return; }",
    '  event.respondWith(strategy(MODE, event.request, {',
    '    fetch: function (request) { return fetch(request); },',
    '    caches: self.caches,',
    '    cacheName: CACHE_NAME,',
    '    waitUntil: function (promise) { event.waitUntil(promise); },',
    '    stamp: stamp,',
    '    report: report',
    '  }));',
    '});',
    '',
  ].join('\n');
};
